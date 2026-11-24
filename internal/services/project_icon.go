package services

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// iconCandidates are where projects commonly keep their icon, best first: app icons (Wails,
// Electron, Tauri, Flutter), then web favicons and logos.
var iconCandidates = []string{
	"build/appicon.png",
	"build/icon.png",
	"build/appicon.svg",
	"src-tauri/icons/icon.png",
	"src-tauri/icons/128x128.png",
	"resources/icon.png",
	"assets/icon.png",
	"assets/icon.svg",
	"assets/logo.png",
	"assets/logo.svg",
	"icon.png",
	"icon.svg",
	"logo.png",
	"logo.svg",
	"app/icon.svg",
	"app/icon.png",
	"src/app/icon.svg",
	"src/app/icon.png",
	"public/apple-touch-icon.png",
	"public/favicon.svg",
	"public/favicon.png",
	"public/logo.svg",
	"public/logo.png",
	"public/icon.svg",
	"public/icon.png",
	"public/favicon.ico",
	"frontend/public/favicon.svg",
	"frontend/public/favicon.png",
	"frontend/public/favicon.ico",
	"web/public/favicon.svg",
	"web/public/favicon.ico",
	"static/favicon.svg",
	"static/favicon.png",
	"static/favicon.ico",
	"src/favicon.svg",
	"src/favicon.ico",
	"app/favicon.ico",
	"src/app/favicon.ico",
	"favicon.svg",
	"favicon.png",
	"favicon.ico",
	"web/favicon.png",
	"assets/images/icon.png",
}

// maxIconBytes keeps huge images (a 4K logo) out of the sidebar.
const maxIconBytes = 512 << 10

var iconTypes = map[string]string{
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
}

// Icon returns a picture for a workspace, found in its folder (an app icon, favicon or logo),
// as a data URL; "" when it has none.
func (p *ProjectService) Icon(projectID string) (string, error) {
	project, err := p.store.Project(projectID)
	if err != nil {
		return "", err
	}
	return findIcon(project.Path), nil
}

func findIcon(dir string) string {
	for _, rel := range iconCandidates {
		if icon := readIcon(filepath.Join(dir, filepath.FromSlash(rel))); icon != "" {
			return icon
		}
	}
	// Not in a usual place: look through the folder for the best-named image.
	for _, path := range searchIcons(dir) {
		if icon := readIcon(path); icon != "" {
			return icon
		}
	}
	return ""
}

// readIcon returns an image file as a data URL, or "" if it is missing, empty or too large.
func readIcon(path string) string {
	mime := iconTypes[strings.ToLower(filepath.Ext(path))]
	info, err := os.Stat(path)
	if mime == "" || err != nil || info.IsDir() || info.Size() == 0 || info.Size() > maxIconBytes {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

const (
	// How deep and how much of a folder the search looks at (WSL folders are slow to list).
	iconSearchDepth   = 5
	iconSearchEntries = 4000
)

// skipDirs are never searched: dependencies, build output, and folders of user content.
var skipDirs = map[string]bool{
	"node_modules": true, "vendor": true, "dist": true, "out": true, "target": true, "bin": true, "obj": true,
	"coverage": true, "__pycache__": true, "venv": true, "storage": true, "uploads": true, "tmp": true,
	"temp": true, "cache": true, "logs": true, "test": true, "tests": true, "__tests__": true, "fixtures": true,
	"testdata": true, "examples": true, "docs": true,
}

// iconNames scores what a file's name says about it being the project's icon.
var iconNames = []struct {
	word  string
	score int
}{
	{"appicon", 100}, {"app-icon", 100}, {"favicon", 90}, {"apple-touch-icon", 85}, {"icon", 70}, {"logo", 50},
}

// iconDirs are where a project's own icon usually is; images there rank higher.
var iconDirs = map[string]int{"public": 10, "static": 10, "assets": 8, "images": 6, "img": 6, "icons": 8, "build": 6, "resources": 6, "res": 4}

// searchIcons lists images in dir whose names suggest an icon, best first.
func searchIcons(dir string) []string {
	type hit struct {
		path  string
		score int
	}
	var hits []hit
	seen := 0
	var walk func(path string, depth, bonus int)
	walk = func(path string, depth, bonus int) {
		entries, err := os.ReadDir(path)
		if err != nil {
			return
		}
		for _, e := range entries {
			if seen++; seen > iconSearchEntries {
				return
			}
			name := strings.ToLower(e.Name())
			if e.IsDir() {
				if depth < iconSearchDepth && !strings.HasPrefix(name, ".") && !skipDirs[name] {
					walk(filepath.Join(path, e.Name()), depth+1, bonus+iconDirs[name])
				}
				continue
			}
			if iconTypes[filepath.Ext(name)] == "" {
				continue
			}
			for _, n := range iconNames {
				if strings.Contains(name, n.word) {
					// Shallower files and ones in icon-ish folders are likelier to be the project's own.
					hits = append(hits, hit{filepath.Join(path, e.Name()), n.score + bonus - depth*3})
					break
				}
			}
		}
	}
	walk(dir, 0, 0)
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].score > hits[j].score })
	paths := make([]string, len(hits))
	for i, h := range hits {
		paths[i] = h.path
	}
	return paths
}
