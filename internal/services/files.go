package services

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"harness/internal/store"
)

const maxPreviewBytes = 512 * 1024

// Entries hidden from the explorer.
var hiddenEntries = map[string]bool{".git": true}

// FileEntry is one item in the file explorer.
type FileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"` // relative to project root, forward slashes
	IsDir bool   `json:"isDir"`
}

// FileService lists and reads files inside a project.
type FileService struct{ store *store.Store }

func NewFileService(s *store.Store) *FileService { return &FileService{store: s} }

// resolve joins rel onto the project root and refuses paths that escape it.
func (f *FileService) resolve(projectID, rel string) (string, error) {
	proj, err := f.store.Project(projectID)
	if err != nil {
		return "", err
	}
	root := filepath.Clean(proj.Path)
	full := filepath.Join(root, filepath.FromSlash(rel))
	if r, err := filepath.Rel(root, full); err != nil || strings.HasPrefix(r, "..") {
		return "", errors.New("path outside project")
	}
	return full, nil
}

func (f *FileService) List(projectID, rel string) ([]FileEntry, error) {
	dir, err := f.resolve(projectID, rel)
	if err != nil {
		return nil, err
	}
	items, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]FileEntry, 0, len(items))
	for _, it := range items {
		if hiddenEntries[it.Name()] {
			continue
		}
		out = append(out, FileEntry{Name: it.Name(), Path: filepath.ToSlash(filepath.Join(rel, it.Name())), IsDir: it.IsDir()})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// Read returns a text file's content for preview.
func (f *FileService) Read(projectID, rel string) (string, error) {
	full, err := f.resolve(projectID, rel)
	if err != nil {
		return "", err
	}
	file, err := os.Open(full)
	if err != nil {
		return "", err
	}
	defer file.Close()
	buf := make([]byte, maxPreviewBytes)
	n, _ := file.Read(buf)
	buf = buf[:n]
	if !utf8.Valid(buf) || strings.ContainsRune(string(buf), 0) {
		return "", errors.New("binary file")
	}
	return string(buf), nil
}
