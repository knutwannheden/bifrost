import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { Note } from '../../shared/types';
import { shortPath, repoDisplayName } from '../utils/paths';
import { matchesRepoSearch } from '../utils/search';
import { isModKey, modSymbol, altSymbol, deleteSymbol } from '../utils/platform';
import { formatTime } from '../utils/format-time';

export default function NotesOverlay() {
  const { state, dispatch } = useApp();
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const repoInputRef = useRef<HTMLInputElement>(null);
  const repoListRef = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [isNewNote, setIsNewNote] = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const creatingRef = useRef(false);

  // Repo selection state
  const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
  const initialRepoId = activeTask?.repoId ?? state.repos[0]?.id ?? '';
  const [repoId, setRepoId] = useState(initialRepoId);
  const initialRepo = state.repos.find((r) => r.id === initialRepoId);
  const [repoSearch, setRepoSearch] = useState(initialRepo ? repoDisplayName(initialRepo) : '');
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [repoFocusedIdx, setRepoFocusedIdx] = useState(0);

  const inputFullySelected =
    repoInputRef.current &&
    repoInputRef.current.selectionStart === 0 &&
    repoInputRef.current.selectionEnd === repoInputRef.current.value.length &&
    repoInputRef.current.value.length > 0;

  const filteredRepos = state.repos.filter((r) => {
    if (!repoSearch || inputFullySelected) return true;
    return matchesRepoSearch(r, repoSearch);
  });

  // Sorted newest first
  const displayNotes = [...notes].reverse();
  // Keep focused index in bounds
  useEffect(() => {
    setRepoFocusedIdx(0);
  }, [repoSearch]);

  useEffect(() => {
    repoListRef.current?.children[repoFocusedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [repoFocusedIdx]);

  // Load notes when repoId changes
  useEffect(() => {
    if (!repoId) {
      setNotes([]);
      setSelectedNoteId(null);
      setDraftText('');
      setIsNewNote(true);
      return;
    }
    window.bifrost.listNotes(repoId).then((loaded) => {
      setNotes(loaded);
      if (loaded.length > 0) {
        const newest = loaded[loaded.length - 1];
        setSelectedNoteId(newest.id);
        setDraftText(newest.text);
        setIsNewNote(false);
      } else {
        setSelectedNoteId(null);
        setDraftText('');
        setIsNewNote(true);
      }
    });
  }, [repoId]);

  // Focus panel on mount so keyboard shortcuts work
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Focus textarea only when entering new-note mode (not on initial mount)
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (isNewNote) {
      textareaRef.current?.focus();
    }
  }, [isNewNote]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const close = () => {
    // Flush any pending edits before unmounting
    if (repoId && !isNewNote && selectedNoteId) {
      flushSave();
      window.bifrost.updateNote(repoId, selectedNoteId, { text: draftText });
    }
    dispatch({ type: 'TOGGLE_NOTES' });
  };

  const selectRepo = (id: string) => {
    const repo = state.repos.find((r) => r.id === id);
    if (repo) {
      setRepoId(id);
      setRepoSearch(repoDisplayName(repo));
      setRepoDropdownOpen(false);
    }
  };

  const saveNote = useCallback((noteId: string, text: string) => {
    if (!repoId) return;
    window.bifrost.updateNote(repoId, noteId, { text }).then((updated) => {
      setNotes((prev) => prev.map((n) => n.id === updated.id ? updated : n));
    });
  }, [repoId]);

  const scheduleSave = useCallback((noteId: string, text: string) => {
    flushSave();
    saveTimerRef.current = setTimeout(() => {
      saveNote(noteId, text);
      saveTimerRef.current = null;
    }, 500);
  }, [flushSave, saveNote]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const selectNote = (noteId: string) => {
    // Flush pending save for previous note
    if (saveTimerRef.current && selectedNoteId && !isNewNote) {
      flushSave();
      saveNote(selectedNoteId, draftText);
    }
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;
    setSelectedNoteId(noteId);
    setDraftText(note.text);
    setIsNewNote(false);
  };

  const startNewNote = () => {
    // Flush pending save
    if (saveTimerRef.current && selectedNoteId && !isNewNote) {
      flushSave();
      saveNote(selectedNoteId, draftText);
    }
    setSelectedNoteId(null);
    setDraftText('');
    setIsNewNote(true);
  };

  const deleteNoteById = async (noteId: string) => {
    if (!repoId) return;
    await window.bifrost.deleteNote(repoId, noteId);
    setNotes((prev) => {
      const filtered = prev.filter((n) => n.id !== noteId);
      if (noteId === selectedNoteId) {
        if (filtered.length > 0) {
          const newest = filtered[filtered.length - 1];
          setSelectedNoteId(newest.id);
          setDraftText(newest.text);
          setIsNewNote(false);
        } else {
          setSelectedNoteId(null);
          setDraftText('');
          setIsNewNote(true);
        }
      }
      return filtered;
    });
  };

  const deleteSelectedNote = () => {
    if (selectedNoteId) deleteNoteById(selectedNoteId);
  };

  const toggleAddressed = async (note: Note) => {
    if (!repoId) return;
    const updated = await window.bifrost.updateNote(repoId, note.id, { addressed: !note.addressed });
    setNotes((prev) => prev.map((n) => n.id === updated.id ? updated : n));
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setDraftText(text);
    if (isNewNote && text.trim() && repoId && !creatingRef.current) {
      // Create note immediately on first input
      creatingRef.current = true;
      window.bifrost.createNote(repoId, text).then((note) => {
        setNotes((prev) => [...prev, note]);
        setSelectedNoteId(note.id);
        setIsNewNote(false);
        creatingRef.current = false;
      });
    } else if (!isNewNote && selectedNoteId) {
      scheduleSave(selectedNoteId, text);
    }
  };

  const handleTextareaBlur = () => {
    if (!isNewNote && selectedNoteId) {
      flushSave();
      saveNote(selectedNoteId, draftText);
    }
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      startNewNote();
      return;
    }
    if (e.altKey && e.code === 'KeyR') {
      e.preventDefault();
      repoInputRef.current?.focus();
      repoInputRef.current?.select();
      return;
    }
    // Cmd+Delete to delete selected note
    if (e.key === 'Backspace' && isModKey(e)) {
      e.preventDefault();
      deleteSelectedNote();
      return;
    }
  };

  const handleOverlayKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // Alt+R to focus repo input
    if (e.altKey && e.code === 'KeyR') {
      e.preventDefault();
      repoInputRef.current?.focus();
      repoInputRef.current?.select();
      return;
    }
    // Alt+N to create new note
    if (e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      startNewNote();
      return;
    }
    // Cmd+Delete to delete
    if (e.key === 'Backspace' && isModKey(e)) {
      e.preventDefault();
      deleteSelectedNote();
      return;
    }
    // Arrow keys when textarea and repo input are not focused → navigate sidebar
    if (document.activeElement !== textareaRef.current && document.activeElement !== repoInputRef.current) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (displayNotes.length === 0) return;
        const currentIdx = selectedNoteId
          ? displayNotes.findIndex((n) => n.id === selectedNoteId)
          : -1;
        let nextIdx: number;
        if (e.key === 'ArrowDown') {
          nextIdx = currentIdx < displayNotes.length - 1 ? currentIdx + 1 : 0;
        } else {
          nextIdx = currentIdx > 0 ? currentIdx - 1 : displayNotes.length - 1;
        }
        selectNote(displayNotes[nextIdx].id);
        // Scroll into view
        const el = sidebarRef.current?.children[nextIdx + 1] as HTMLElement | undefined; // +1 for the button
        el?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter' && selectedNoteId) {
        e.preventDefault();
        return;
      }
    }
  };

  const handleRepoInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Let overlay-level Alt shortcuts work from the repo input
    if (e.altKey && e.code === 'KeyN') {
      e.preventDefault();
      startNewNote();
      return;
    }
    if (filteredRepos.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!repoDropdownOpen) {
          setRepoDropdownOpen(true);
        } else {
          setRepoFocusedIdx((i) => i < filteredRepos.length - 1 ? i + 1 : 0);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!repoDropdownOpen) {
          setRepoDropdownOpen(true);
        } else {
          setRepoFocusedIdx((i) => i > 0 ? i - 1 : filteredRepos.length - 1);
        }
        break;
      case 'Enter':
        if (repoDropdownOpen) {
          e.preventDefault();
          e.stopPropagation();
          if (filteredRepos[repoFocusedIdx]) {
            selectRepo(filteredRepos[repoFocusedIdx].id);
          }
        }
        break;
      case 'Tab':
        if (repoDropdownOpen && filteredRepos[repoFocusedIdx]) {
          selectRepo(filteredRepos[repoFocusedIdx].id);
        }
        break;
    }
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-overlay"
      onClick={close}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={handleOverlayKeyDown}
        className="bg-surface rounded-lg border border-border-input w-[720px] flex flex-col shadow-xl min-h-[80vh] max-h-[90vh] outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default gap-3">
          <span className="text-sm font-medium text-primary flex-shrink-0">Notes</span>
          <div className="flex items-center gap-1.5 flex-1 max-w-[280px]">
          <label className="text-xs text-secondary flex-shrink-0"><span className="underline">R</span>epo</label>
          <div className="relative flex-1">
            <input
              ref={repoInputRef}
              type="text"
              value={repoSearch}
              onChange={(e) => {
                setRepoSearch(e.target.value);
                setRepoDropdownOpen(true);
                const match = state.repos.find((r) => r.id === repoId);
                if (match && !matchesRepoSearch(match, e.target.value)) {
                  setRepoId('');
                }
              }}
              onFocus={() => {
                repoInputRef.current?.select();
              }}
              onBlur={() => {
                setTimeout(() => setRepoDropdownOpen(false), 150);
              }}
              onKeyDown={handleRepoInputKeyDown}
              placeholder="Select repository..."
              className="w-full px-2.5 py-1 bg-surface-alt border border-border-input rounded text-xs text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
            {repoDropdownOpen && filteredRepos.length > 0 && (
              <div
                ref={repoListRef}
                className="absolute z-10 mt-1 w-full bg-surface-alt border border-border-input rounded shadow-lg max-h-[200px] overflow-y-auto"
              >
                {filteredRepos.map((repo, idx) => (
                  <div
                    key={repo.id}
                    onMouseDown={() => selectRepo(repo.id)}
                    onMouseEnter={() => setRepoFocusedIdx(idx)}
                    className={`px-2.5 py-1.5 cursor-pointer ${
                      idx === repoFocusedIdx
                        ? 'bg-accent text-white'
                        : 'text-primary hover:bg-surface-hover'
                    }`}
                  >
                    <div className="text-xs">{repoDisplayName(repo)}</div>
                    <div className={`text-[10px] font-mono ${idx === repoFocusedIdx ? 'text-blue-200' : 'text-secondary'}`}>
                      {shortPath(repo.path)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          </div>
          <button
            onClick={close}
            tabIndex={-1}
            className="text-secondary hover:text-primary text-lg leading-none flex-shrink-0"
          >
            &times;
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex-1 flex min-h-0">
          {/* Sidebar */}
          <div ref={sidebarRef} className="w-44 flex-shrink-0 border-r border-border-default flex flex-col overflow-hidden">
            {/* New Note button */}
            <button
              onClick={startNewNote}
              className={`mx-2 mt-2 mb-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                isNewNote
                  ? 'bg-accent text-white'
                  : 'bg-surface-alt text-secondary hover:bg-surface-hover'
              }`}
            >
              + <span className="underline">N</span>ew Note
            </button>

            {/* Note list */}
            <div className="flex-1 overflow-y-auto">
              {!repoId ? (
                <div className="px-3 py-4 text-xs text-muted text-center">
                  Select a repository
                </div>
              ) : displayNotes.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted text-center">
                  No notes yet
                </div>
              ) : (
                displayNotes.map((note) => {
                  const firstLine = note.text.split('\n')[0] || 'Empty note';
                  const isActive = !isNewNote && note.id === selectedNoteId;
                  return (
                    <div
                      key={note.id}
                      onClick={() => selectNote(note.id)}
                      className={`group px-3 py-2 cursor-pointer border-l-2 transition-colors ${
                        isActive
                          ? 'bg-surface-alt/50 border-accent-hover'
                          : 'border-transparent hover:bg-surface'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={note.addressed}
                          onChange={(e) => { e.stopPropagation(); toggleAddressed(note); }}
                          onClick={(e) => e.stopPropagation()}
                          className="accent-blue-500 flex-shrink-0"
                        />
                        <span className="text-xs text-secondary truncate flex-1">
                          {firstLine.length > 30 ? firstLine.slice(0, 30) + '\u2026' : firstLine}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteNoteById(note.id); }}
                          className="opacity-0 group-hover:opacity-100 text-danger hover:brightness-125 flex-shrink-0 transition-opacity"
                          title="Delete note"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                            <path fillRule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5A.75.75 0 0 1 9.95 6Z" clipRule="evenodd" />
                          </svg>
                        </button>
                      </div>
                      <span className="text-[10px] text-muted ml-5 block">
                        {formatTime(note.createdAt)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 flex flex-col min-w-0">
            {!repoId ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted">
                Select a repository
              </div>
            ) : (
              <>
                <textarea
                  ref={textareaRef}
                  value={draftText}
                  onChange={handleTextareaChange}
                  onBlur={handleTextareaBlur}
                  onKeyDown={handleTextareaKeyDown}
                  placeholder={isNewNote ? 'Type a new note...' : 'Note text...'}
                  className="flex-1 bg-transparent text-sm text-primary placeholder-muted p-4 resize-none outline-none min-h-0"
                />
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 pb-3 pt-2 border-t border-border-default">
          <p className="text-xs text-muted">
            Esc to close · {altSymbol}N new note · ↑↓ navigate · {modSymbol}{deleteSymbol} delete
          </p>
        </div>
      </div>
    </div>
  );
}
