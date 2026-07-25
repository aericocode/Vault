/**
 * wizard — interactive, flag-free scan management.
 *
 * Launched by running `node video-tagger.js` with no command (or explicitly
 * via `node video-tagger.js wizard`). Arrow-key menus and toggles replace
 * remembering CLI flags; the equivalent flag command is printed before each
 * run so the flags stay learnable.
 *
 * Last-used answers + directory history persist in wizard-settings.json.
 */

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const { ROOT } = require('../lib/approot');

const SETTINGS_PATH = path.join(ROOT, 'wizard-settings.json');
const DIR_HISTORY_MAX = 8;

/* ── Settings persistence ─────────────────────────────────────────────── */

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return { dirHistory: [], last: {} };
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch {}
}

function rememberDirectory(settings, dir) {
  settings.dirHistory = [dir, ...settings.dirHistory.filter(d => d !== dir)]
    .slice(0, DIR_HISTORY_MAX);
}

/* ── Answer → CLI args (pure; unit-testable) ──────────────────────────── */

const TYPE_CHOICES = [
  { title: 'Video + images + GIFs (default)', value: 'default' },
  { title: 'Everything (audio, documents too)', value: 'all' },
  { title: 'Video only', value: 'video' },
  { title: 'Images only', value: 'image' },
  { title: 'Audio only', value: 'audio' },
  { title: 'Documents only', value: 'document' },
];

// Types that only exist in the processor registry (need --all-types)
const REGISTRY_ONLY_TYPES = new Set(['audio', 'document']);

function buildScanArgs(a) {
  const args = [a.dir];
  if (a.recursive) args.push('--recursive');

  if (a.types === 'all') {
    args.push('--all-types');
  } else if (a.types !== 'default') {
    if (REGISTRY_ONLY_TYPES.has(a.types)) args.push('--all-types');
    args.push('--type', a.types);
  }

  if (a.transcribe) args.push('--transcribe-video');
  if (a.fingerprintAudio) args.push('--fingerprint-audio');

  if (a.mode === 'retry') args.push('--retry-errors');
  else if (a.mode === 'reprocess') args.push('--reprocess');

  if (a.workers && a.workers > 0) args.push('--workers', String(a.workers));

  return args;
}

function formatCommand(args) {
  const quoted = args.map(x => /[\s()&]/.test(x) ? `"${x}"` : x);
  return `node video-tagger.js scan ${quoted.join(' ')}`;
}

/* ── Prompts ──────────────────────────────────────────────────────────── */

const onCancel = () => {
  console.log('\nCancelled.');
  process.exit(0);
};

/**
 * Directory picker: autocomplete over history, but any typed path is
 * accepted too (the typed input is injected as the first suggestion).
 */
async function askDirectory(settings) {
  const history = settings.dirHistory || [];

  while (true) {
    let dir;
    if (history.length > 0) {
      const res = await prompts({
        type: 'autocomplete',
        name: 'dir',
        message: 'Directory to scan (type a path or pick from history)',
        choices: history.map(d => ({ title: d, value: d })),
        suggest: (input, choices) => {
          const filtered = choices.filter(c =>
            c.title.toLowerCase().includes(input.toLowerCase()));
          if (input && !filtered.some(c => c.title === input)) {
            filtered.unshift({ title: input, value: input });
          }
          return Promise.resolve(filtered.length ? filtered : [{ title: input, value: input }]);
        },
      }, { onCancel });
      dir = res.dir;
    } else {
      const res = await prompts({
        type: 'text',
        name: 'dir',
        message: 'Directory to scan',
        initial: settings.last?.dir || '',
      }, { onCancel });
      dir = res.dir;
    }

    dir = (dir || '').trim().replace(/^"|"$/g, '');
    if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return dir;
    }
    console.log(`  ✗ Not a directory: ${dir || '(empty)'} — try again`);
  }
}

async function scanWizard(settings) {
  const last = settings.last || {};

  const dir = await askDirectory(settings);

  const answers = await prompts([
    {
      type: 'toggle',
      name: 'recursive',
      message: 'Include subdirectories?',
      initial: last.recursive ?? true,
      active: 'yes',
      inactive: 'no',
    },
    {
      type: 'select',
      name: 'types',
      message: 'Which file types?',
      choices: TYPE_CHOICES,
      initial: Math.max(0, TYPE_CHOICES.findIndex(c => c.value === (last.types || 'default'))),
    },
    {
      type: 'toggle',
      name: 'transcribe',
      message: 'Transcribe video audio? (faster-whisper)',
      initial: last.transcribe ?? false,
      active: 'yes',
      inactive: 'no',
    },
    {
      // Audio-only: offer to fingerprint for Music ID in the same pass. Runs
      // alongside the AI scan (ffmpeg is idle while whisper/LM work the GPU),
      // so it doesn't serialize behind the scan.
      type: (prev, values) => values.types === 'audio' ? 'toggle' : null,
      name: 'fingerprintAudio',
      message: 'Also fingerprint audio for Music ID? (build song references)',
      initial: last.fingerprintAudio ?? true,
      active: 'yes',
      inactive: 'no',
    },
    {
      type: 'select',
      name: 'mode',
      message: 'Which files to process?',
      choices: [
        { title: 'New files only (skip everything already scanned)', value: 'new' },
        { title: 'New + retry files with Vision API errors', value: 'retry' },
        { title: 'Reprocess EVERYTHING (re-analyzes all files)', value: 'reprocess' },
      ],
      initial: 0,
    },
    {
      type: 'number',
      name: 'workers',
      message: 'Parallel workers (0 = auto based on GPUs/endpoints)',
      initial: last.workers ?? 0,
      min: 0,
      max: 32,
    },
  ], { onCancel });

  const full = { dir, ...answers };
  const args = buildScanArgs(full);

  console.log('');
  console.log(`  Equivalent command:`);
  console.log(`  ${formatCommand(args)}`);
  console.log('');

  const { go } = await prompts({
    type: 'confirm',
    name: 'go',
    message: full.mode === 'reprocess'
      ? '⚠ Reprocess re-analyzes every file — start scan?'
      : 'Start scan?',
    initial: true,
  }, { onCancel });

  if (!go) {
    console.log('Not started.');
    return;
  }

  // Remember choices for next time
  rememberDirectory(settings, dir);
  settings.last = { ...full };
  saveSettings(settings);

  await require('./scan').run(args);
}

/* ── Main menu ────────────────────────────────────────────────────────── */

async function run(args) {
  console.log('');
  console.log('  🔎 Video Tagger — interactive mode');
  console.log('     (power users: run `node video-tagger.js --help` for flags)');

  const settings = loadSettings();

  // Loop the menu so finishing a scan drops back to the list instead of
  // closing the terminal — pick another directory (or task) and keep going.
  while (true) {
    console.log('');
    const { action } = await prompts({
      type: 'select',
      name: 'action',
      message: 'What do you want to do?',
      choices: [
        { title: '📁 Scan a directory', value: 'scan', description: 'analyze new media with AI' },
        { title: '🧠 Build semantic search index', value: 'embed', description: 'embed existing metadata (no rescan)' },
        { title: '📊 Library status', value: 'status', description: 'counts by type/language/errors' },
        { title: '🌐 How to open the viewer', value: 'viewer' },
        { title: '✕ Exit', value: 'exit' },
      ],
    }, { onCancel });

    if (!action || action === 'exit') break;

    switch (action) {
      case 'scan':
        await scanWizard(settings);
        break;
      case 'embed':
        await require('./embed').run([]);
        break;
      case 'status':
        await require('./status').run([]);
        break;
      case 'viewer':
        console.log('\n  Double-click start.bat, or run: npm run viewer');
        console.log('  Then open http://127.0.0.1:8765');
        break;
    }

    console.log('\n' + '─'.repeat(52));
  }

  console.log('\n  Done — bye.\n');
}

module.exports = { run, buildScanArgs, formatCommand };
