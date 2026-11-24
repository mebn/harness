package services

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"

	"harness/server/internal/gitx"
)

const (
	// maxListedFiles caps the file list of a huge folder (the finder stays responsive).
	maxListedFiles = 50_000
	// maxSearchBytes skips large files (logs, bundles) in text search.
	maxSearchBytes = 1 << 20
	maxMatches     = 2_000
	// Long lines are cut to this many characters around the match.
	previewChars = 160
	searchWorkers = 8
)

// Folders skipped when listing a folder that isn't a git repository.
var skippedDirs = map[string]bool{".git": true, "node_modules": true, ".venv": true, "__pycache__": true, ".next": true, "dist": true, "build": true, "target": true}

// ListAll returns every file of a project (or worktree), relative to its folder: what git
// tracks or would add, or, outside a repository, everything but common build folders.
func (f *FileService) ListAll(projectID, worktree string) ([]string, error) {
	loc, err := locate(f.store, projectID, worktree)
	if err != nil {
		return nil, err
	}
	files, err := gitx.Repo{Dir: loc.Dir, Env: loc.Env}.Files(context.Background())
	if err != nil {
		files, err = walkFiles(loc.Dir)
		if err != nil {
			return nil, err
		}
	}
	kept := files[:0]
	for _, p := range files {
		if !strings.HasPrefix(p, gitx.WorktreesDir+"/") {
			kept = append(kept, p)
		}
	}
	if len(kept) > maxListedFiles {
		kept = kept[:maxListedFiles]
	}
	sort.Strings(kept)
	return kept, nil
}

func walkFiles(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped
		}
		if d.IsDir() {
			if path != root && (skippedDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		out = append(out, filepath.ToSlash(rel))
		if len(out) >= maxListedFiles {
			return fs.SkipAll
		}
		return nil
	})
	return out, err
}

// SearchOptions tune a text search.
type SearchOptions struct {
	CaseSensitive bool `json:"caseSensitive"`
	WholeWord     bool `json:"wholeWord"`
	Regex         bool `json:"regex"`
}

// SearchMatch is one matching line. Start and End mark the match in Text, in UTF-16 units
// (JavaScript string offsets).
type SearchMatch struct {
	Line  int    `json:"line"`
	Text  string `json:"text"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

// SearchFile groups the matches in one file.
type SearchFile struct {
	Path    string        `json:"path"`
	Matches []SearchMatch `json:"matches"`
}

// SearchResult is a text search's outcome; Truncated means it stopped at the match limit.
type SearchResult struct {
	Files     []SearchFile `json:"files"`
	Total     int          `json:"total"`
	Truncated bool         `json:"truncated"`
}

// Search finds query in the text files of a project (or worktree), like VS Code's search.
func (f *FileService) Search(projectID, worktree, query string, opts SearchOptions) (SearchResult, error) {
	result := SearchResult{Files: []SearchFile{}}
	if query == "" {
		return result, nil
	}
	re, err := searchPattern(query, opts)
	if err != nil {
		return result, err
	}
	loc, err := locate(f.store, projectID, worktree)
	if err != nil {
		return result, err
	}
	paths, err := f.ListAll(projectID, worktree)
	if err != nil {
		return result, err
	}

	var (
		mu    sync.Mutex
		total int
		wg    sync.WaitGroup
		jobs  = make(chan string)
	)
	full := func() bool {
		mu.Lock()
		defer mu.Unlock()
		return total >= maxMatches
	}
	for range searchWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for rel := range jobs {
				if full() {
					continue
				}
				matches := searchFile(filepath.Join(loc.Dir, filepath.FromSlash(rel)), re)
				if len(matches) == 0 {
					continue
				}
				mu.Lock()
				if room := maxMatches - total; len(matches) > room {
					matches = matches[:room]
					result.Truncated = true
				}
				total += len(matches)
				if len(matches) > 0 {
					result.Files = append(result.Files, SearchFile{Path: rel, Matches: matches})
				}
				mu.Unlock()
			}
		}()
	}
	for _, p := range paths {
		if full() {
			result.Truncated = true
			break
		}
		jobs <- p
	}
	close(jobs)
	wg.Wait()

	sort.Slice(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path })
	result.Total = total
	return result, nil
}

func searchPattern(query string, opts SearchOptions) (*regexp.Regexp, error) {
	expr := query
	if !opts.Regex {
		expr = regexp.QuoteMeta(query)
	}
	if opts.WholeWord {
		expr = `\b(?:` + expr + `)\b`
	}
	if !opts.CaseSensitive {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, errors.New("invalid regular expression")
	}
	return re, nil
}

// searchFile returns the matching lines of a text file (none for binary or large files).
func searchFile(path string, re *regexp.Regexp) []SearchMatch {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() > maxSearchBytes {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil || bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return nil
	}
	var out []SearchMatch
	for i, line := range strings.Split(string(data), "\n") {
		loc := re.FindStringIndex(line)
		if loc == nil || loc[0] == loc[1] {
			continue
		}
		out = append(out, preview(i+1, strings.TrimRight(line, "\r"), loc[0], loc[1]))
	}
	return out
}

// preview trims a long line around the match and converts offsets to UTF-16.
func preview(lineNo int, line string, start, end int) SearchMatch {
	if end > len(line) {
		end = len(line)
	}
	lead := strings.TrimLeft(line[:start], " \t")
	prefix := ""
	if utf8.RuneCountInString(lead) > previewChars/3 {
		r := []rune(lead)
		lead = string(r[len(r)-previewChars/3:])
		prefix = "…"
	}
	match := line[start:end]
	tail := line[end:]
	if r := []rune(tail); len(r) > previewChars {
		tail = string(r[:previewChars]) + "…"
	}
	head := prefix + lead
	s := len(utf16.Encode([]rune(head)))
	return SearchMatch{Line: lineNo, Text: head + match + tail, Start: s, End: s + len(utf16.Encode([]rune(match)))}
}
