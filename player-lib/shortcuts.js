/* =========================================================================
   SHORTCUTS - every keyboard shortcut in the app, as data

   The single source the Settings shortcuts page will render from. Not loaded
   by the viewer yet (that page is still being designed), so nothing reads it
   at runtime today.

   Keep it in step with the "Keyboard shortcuts" section of SETUP.md: same
   groups, same rows, same wording. test/shortcuts-docs.test.js fails when an
   action here is missing from SETUP.md. The handlers themselves live in
   player/player-controls.js (full player), app.js (mini player, library
   Escape), cards.js (page keys), filter-chips.js and filter-popover.js
   (filters), editor.js (mix editor), notes.js, metadata-edit.js and
   settings.js (Ctrl+Shift+H).

   Shape: [{ group, note?, items: [{ keys: [...], action }] }]. Each entry in
   `keys` is one key or combination that does the action (alternatives, not a
   sequence).
   ========================================================================= */

const VAULT_SHORTCUTS = [
  {
    group: 'Video and audio',
    items: [
      { keys: ['Space'], action: 'Play or pause' },
      { keys: ['←', '→'], action: 'Back or forward 5 seconds' },
      { keys: ['J', 'L'], action: 'Back or forward 10 seconds' },
      { keys: ['0', '1', '…', '9'], action: 'Jump to a point in the file: 0 is the start, 1 is 10%, 5 is halfway, 9 is 90%' },
      { keys: ['↑', '↓'], action: 'Volume up or down' },
      { keys: ['M'], action: 'Mute or unmute' },
      { keys: ['['], action: 'Set the loop start (A)' },
      { keys: [']'], action: 'Set the loop end (B) and start looping' },
      { keys: ['\\'], action: 'Clear the A-B loop' },
      { keys: [',', '<'], action: 'Slower' },
      { keys: ['.', '>'], action: 'Faster' },
      { keys: ['Q'], action: 'Shrink to the mini player' },
    ],
  },
  {
    group: 'Images and GIFs',
    items: [
      { keys: ['↑', '+'], action: 'Zoom in' },
      { keys: ['↓', '-'], action: 'Zoom out' },
      { keys: ['R'], action: 'Rotate right' },
      { keys: ['0'], action: 'Reset zoom and rotation' },
    ],
  },
  {
    group: 'Documents',
    items: [
      { keys: ['+', '-'], action: 'Bigger or smaller text' },
    ],
  },
  {
    group: 'Any file in the player',
    items: [
      { keys: ['F'], action: 'Fullscreen on or off' },
      { keys: ['I'], action: 'Show or hide the info sidebar' },
      { keys: ['N', 'Alt+→'], action: 'Next file' },
      { keys: ['P', 'Alt+←'], action: 'Previous file' },
      { keys: ['R'], action: 'Random file (on images and GIFs, R rotates instead)' },
      { keys: ['Esc'], action: 'Step back one layer: leave fullscreen, then close the sidebar, then close the player' },
    ],
  },
  {
    group: 'Mixes in the player',
    note: 'A mix plays with the video controls, but only some video keys reach it so far. Use the on-screen buttons for play, skip, volume, loop and speed.',
    items: [
      { keys: ['0', '1', '…', '9'], action: 'Jump to 0%, 10% … 90% of the mix' },
      { keys: ['F', 'I', 'N', 'P', 'R', 'Esc'], action: 'Same as for any file in the player' },
    ],
  },
  {
    group: 'Mini player',
    items: [
      { keys: ['Space'], action: 'Play or pause' },
      { keys: ['0', '1', '…', '9'], action: 'Jump to 0%, 10% … 90% of the file' },
      { keys: ['N', 'P'], action: 'Next or previous file' },
      { keys: ['R'], action: 'Random file' },
      { keys: ['Q'], action: 'Back to the full player' },
      { keys: ['Esc'], action: 'Close the mini player' },
    ],
  },
  {
    group: 'Library',
    items: [
      { keys: ['Page Down', 'Page Up'], action: 'Next or previous page (Pages layout)' },
      { keys: ['Home', 'End'], action: 'First or last page (Pages layout)' },
      { keys: ['Esc'], action: 'Close the open filter list, then the filter panel, then the file details window' },
      { keys: ['Ctrl+Shift+H'], action: 'Privacy mode on or off (works everywhere)' },
    ],
  },
  {
    group: 'Filters',
    items: [
      { keys: ['Enter', 'Space'], action: 'Open the focused filter chip' },
      { keys: ['↑', '↓'], action: 'Move through a filter list' },
      { keys: ['Home', 'End'], action: 'First or last entry in a filter list' },
      { keys: ['Enter'], action: 'Choose the highlighted entry' },
      { keys: ['Esc'], action: 'Close the filter list' },
    ],
  },
  {
    group: 'Mix editor',
    items: [
      { keys: ['Space'], action: 'Play or pause the mix' },
      { keys: ['←', '→'], action: 'Back or forward 5 seconds' },
      { keys: ['Shift+←', 'Shift+→'], action: 'Back or forward 10 seconds' },
      { keys: ['M'], action: 'Show or hide the mixer' },
      { keys: ['[', ']'], action: 'Loop: first press sets the start, second sets the end, third clears it' },
      { keys: ['\\'], action: 'Clear the loop' },
    ],
  },
  {
    group: 'Notes and editing',
    items: [
      { keys: ['Enter'], action: 'Add the note you typed' },
      { keys: ['Shift+Enter'], action: 'New line in a note' },
      { keys: ['Esc'], action: 'Cancel editing a note' },
      { keys: ['Enter'], action: 'Save an edited field, name or collection' },
      { keys: ['Ctrl+Enter'], action: 'Save a multi-line field' },
      { keys: ['Esc'], action: 'Cancel editing a field, name or collection' },
    ],
  },
  {
    group: 'Everywhere else',
    items: [
      { keys: ['Esc'], action: 'Close Settings, the speed menu, the subtitle editor, the import window, the Obsession Score stats and password dialogs' },
      { keys: ['Esc'], action: 'Stop Vibe sync right away while it is running' },
      { keys: ['Space'], action: 'Frame Fit game: hold and drag to move around the board' },
    ],
  },
];
