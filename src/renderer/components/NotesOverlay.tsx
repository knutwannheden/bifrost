import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { Note } from '../../shared/types';

export default function NotesOverlay() {
  const { state, dispatch } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const activeTask = state.tasks.find((t) => t.id === state.activeTaskId);
  const repoId = activeTask?.repoId;
  const repo = state.repos.find((r) => r.id === repoId);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!repoId) return;
    window.bifrost.listNotes(repoId).then(setNotes);
  }, [repoId]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list || selectedIndex < 0) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const close = () => dispatch({ type: 'TOGGLE_NOTES' });

  const addNote = async () => {
    const text = inputValue.trim();
    if (!text || !repoId) return;
    const note = await window.bifrost.createNote(repoId, text);
    setNotes((prev) => [...prev, note]);
    setInputValue('');
    setSelectedIndex(-1);
  };

  const removeNote = async (noteId: string) => {
    if (!repoId) return;
    await window.bifrost.deleteNote(repoId, noteId);
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    setSelectedIndex((i) => {
      const newLen = notes.length - 1;
      if (newLen <= 0) return -1;
      return i >= newLen ? newLen - 1 : i;
    });
  };

  const copyAsContext = async () => {
    if (selectedIndex < 0 || !activeTask) return;
    const reversed = [...notes].reverse();
    const note = reversed[selectedIndex];
    if (!note) return;
    const id = await window.bifrost.captureContext({
      type: 'activity',
      content: note.text,
      taskId: activeTask.id,
      taskName: activeTask.name,
    });
    dispatch({ type: 'SHOW_TOAST', message: `[Bifrost #${id}] copied` });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd+Shift+C: copy selected note as context reference
    if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      e.stopPropagation();
      copyAsContext();
      return;
    }

    const reversed = [...notes].reverse();

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Enter':
        e.preventDefault();
        addNote();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (reversed.length > 0) {
          setSelectedIndex((i) => (i < reversed.length - 1 ? i + 1 : 0));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (reversed.length > 0) {
          setSelectedIndex((i) => (i > 0 ? i - 1 : reversed.length - 1));
        }
        break;
      case 'Backspace':
      case 'Delete':
        if (inputValue === '' && selectedIndex >= 0) {
          e.preventDefault();
          const note = reversed[selectedIndex];
          if (note) removeNote(note.id);
        }
        break;
    }
  };

  // Reverse chronological order (newest first)
  const displayNotes = [...notes].reverse();

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/30"
      onClick={close}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-slate-800 rounded-lg border border-slate-600 w-[480px] flex flex-col shadow-xl max-h-[60vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with input */}
        <div className="flex items-center px-4 py-3 border-b border-slate-700">
          {repo && (
            <span className="text-xs text-slate-500 mr-3 whitespace-nowrap">{repo.name}</span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={repoId ? 'Type a note and press Enter…' : 'No active task'}
            disabled={!repoId}
            className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 outline-none"
          />
          <button
            onClick={close}
            tabIndex={-1}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none ml-2"
          >
            &times;
          </button>
        </div>

        {/* Notes list */}
        <div ref={listRef} className="p-2 overflow-y-auto flex-1 min-h-0">
          {!repoId ? (
            <div className="px-2 py-6 text-sm text-slate-500 text-center">
              Open a task to use notes
            </div>
          ) : displayNotes.length === 0 ? (
            <div className="px-2 py-6 text-sm text-slate-500 text-center">
              No notes yet
            </div>
          ) : (
            displayNotes.map((note, i) => (
              <div
                key={note.id}
                className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer ${
                  i === selectedIndex ? 'bg-slate-700' : 'hover:bg-slate-700/50'
                }`}
                onClick={() => setSelectedIndex(i === selectedIndex ? -1 : i)}
              >
                <span className="text-sm text-slate-300 flex-1 break-words">{note.text}</span>
                <span className="text-xs text-slate-500 whitespace-nowrap mt-0.5">
                  {formatTime(note.createdAt)}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 pb-3 pt-2 border-t border-slate-700">
          <p className="text-xs text-slate-500">
            Enter to add · ↑↓ to select · Delete to remove · ⌘⇧C to copy as context ref
          </p>
        </div>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
