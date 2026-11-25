package services

import (
	"errors"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"harness/internal/attach"
	"harness/internal/platform"
	"harness/internal/provider"
	"harness/internal/store"
)

// ProjectService manages the sidebar tree: projects and their sessions.
type ProjectService struct {
	store     *store.Store
	providers *provider.Registry
	files     attach.Store
	chat      *ChatService // told about settings changes and deleted chats (may be nil)
}

func NewProjectService(s *store.Store, r *provider.Registry, files attach.Store, chat *ChatService) *ProjectService {
	return &ProjectService{store: s, providers: r, files: files, chat: chat}
}

// Tree returns all projects with their sessions. Env is always derived from the path.
func (p *ProjectService) Tree() ([]store.ProjectTree, error) {
	tree, err := p.store.Tree()
	for i := range tree {
		tree[i].Project.Env = string(platform.EnvForPath(tree[i].Project.Path))
	}
	return tree, err
}

func (p *ProjectService) AddProject(path string) (store.Project, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return store.Project{}, errors.New("path is required")
	}
	proj := store.Project{
		ID:       uuid.NewString(),
		Name:     filepath.Base(filepath.Clean(path)),
		Path:     path,
		Env:      string(platform.EnvForPath(path)),
		Expanded: true,
	}
	err := p.store.InsertProject(&proj)
	p.changed()
	return proj, err
}

// changed tells every window the sidebar tree changed.
func (p *ProjectService) changed() {
	if p.chat != nil {
		p.chat.emit(EventTreeChanged, nil)
	}
}

// RemoveProject forgets a workspace (its folder on disk is untouched) and its sessions.
func (p *ProjectService) RemoveProject(id string) error {
	if tree, err := p.store.Tree(); err == nil {
		for _, n := range tree {
			if n.Project.ID == id {
				for _, s := range n.Sessions {
					if p.chat != nil {
						p.chat.sessionDeleted(s.ID)
					}
					_ = p.files.RemoveSession(s.ID)
				}
			}
		}
	}
	err := p.store.DeleteProject(id)
	p.changed()
	return err
}

func (p *ProjectService) update(id string, fn func(*store.Project)) error {
	proj, err := p.store.Project(id)
	if err != nil {
		return err
	}
	fn(&proj)
	if err := p.store.UpdateProject(proj); err != nil {
		return err
	}
	p.changed()
	return nil
}

func (p *ProjectService) RenameProject(id, name string) error {
	return p.update(id, func(x *store.Project) { x.Name = strings.TrimSpace(name) })
}

func (p *ProjectService) SetExpanded(id string, expanded bool) error {
	return p.update(id, func(x *store.Project) { x.Expanded = expanded })
}

// SetRunAsAdmin chooses whether the workspace's chats and new terminals run as administrator
// (Windows folders). Chats pick it up when their agent next starts; idle ones restart for it.
func (p *ProjectService) SetRunAsAdmin(id string, admin bool) error {
	return p.update(id, func(x *store.Project) { x.RunAsAdmin = admin })
}

// CreateSession starts a new session in the project's folder or one of its worktrees,
// inheriting settings from the last used session.
func (p *ProjectService) CreateSession(projectID, worktree string) (store.Session, error) {
	if _, err := locate(p.store, projectID, worktree); err != nil {
		return store.Session{}, err
	}
	sess := store.Session{
		ID:                uuid.NewString(),
		ProjectID:         projectID,
		Worktree:          worktree,
		Title:             "New session",
		ProviderSessionID: uuid.NewString(),
		Mode:              provider.ModeFull,
	}
	if last, ok := p.store.LatestSession(); ok {
		sess.Provider, sess.Model, sess.Effort, sess.Mode, sess.Fast = last.Provider, last.Model, last.Effort, last.Mode, last.Fast
	}
	// Defaults chosen in Settings win over the last chat's model; its mode stays.
	if d := loadNewChatDefaults(p.store, p.providers); d.Provider != "" {
		if d.Provider != sess.Provider {
			sess.Fast = false
		}
		sess.Provider, sess.Model, sess.Effort = d.Provider, d.Model, d.Effort
	}
	if _, ok := p.providers.Get(sess.Provider); !ok {
		info := p.providers.Default().Info()
		sess.Provider, sess.Model, sess.Effort = info.ID, info.DefaultModel, info.DefaultEffort
	}
	err := p.store.InsertSession(&sess)
	p.changed()
	return sess, err
}

// SetSessionWorktree moves a session that hasn't started into a worktree ("" = the project's
// folder). A started session stays where it began: the CLI resumes sessions per folder.
func (p *ProjectService) SetSessionWorktree(id, worktree string) (store.Session, error) {
	sess, err := p.store.Session(id)
	if err != nil || sess.Worktree == worktree {
		return sess, err
	}
	if sess.Started {
		return sess, errors.New("this chat has started; it keeps running where it began")
	}
	if _, err := locate(p.store, sess.ProjectID, worktree); err != nil {
		return sess, err
	}
	sess.Worktree = worktree
	return sess, p.store.UpdateSession(&sess)
}

func (p *ProjectService) RenameSession(id, title string) error {
	sess, err := p.store.Session(id)
	if err != nil {
		return err
	}
	sess.Title = strings.TrimSpace(title)
	if err := p.store.UpdateSession(&sess); err != nil {
		return err
	}
	p.changed()
	return nil
}

func (p *ProjectService) DeleteSession(id string) error {
	if p.chat != nil {
		p.chat.sessionDeleted(id)
	}
	_ = p.files.RemoveSession(id)
	err := p.store.DeleteSession(id)
	p.changed()
	return err
}

// UpdateSessionSettings changes provider/model/effort/mode for future turns.
// Switching provider starts a fresh provider-side conversation.
func (p *ProjectService) UpdateSessionSettings(id, providerID, model, effort, mode string, fast bool) (store.Session, error) {
	sess, err := p.store.Session(id)
	if err != nil {
		return sess, err
	}
	prov, ok := p.providers.Get(providerID)
	if !ok {
		return sess, errors.New("unknown provider: " + providerID)
	}
	if sess.Provider != providerID {
		info := prov.Info()
		sess.Provider = providerID
		sess.ProviderSessionID = uuid.NewString()
		sess.Started = false
		if !hasOption(info.Models, model) {
			model = info.DefaultModel
		}
		if !hasOption(info.Efforts, effort) {
			effort = info.DefaultEffort
		}
	}
	canFast := prov.Info().Fast
	if fast != sess.Fast || !canFast {
		sess.FastState, sess.FastOffReason = "", "" // unknown until the next turn reports it
	}
	sess.Model, sess.Effort, sess.Mode, sess.Fast = model, effort, mode, fast && canFast
	if err := p.store.UpdateSession(&sess); err != nil {
		return sess, err
	}
	if p.chat != nil {
		p.chat.settingsChanged(sess)
	}
	return sess, nil
}

func hasOption(opts []provider.Option, id string) bool {
	for _, o := range opts {
		if o.ID == id {
			return true
		}
	}
	return false
}
