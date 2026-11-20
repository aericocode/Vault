/**
 * Media-type specific prompts for vision + text analysis
 *
 * All prompt templates live here (vision: image/gif/video, text: document).
 *
 * Two ways the answer's shape reaches the model:
 * - structured (the default when the server takes it): the shape is sent as a
 *   real JSON schema in response_format (buildResponseSchema), so the reply is
 *   valid JSON by construction, content_type can only be one of CONTENT_TYPES
 *   and the lists have a maximum length. The prompt then carries only the
 *   field guidance, as a compact list.
 * - prompt only (a server that refuses or ignores response_format): the same
 *   guidance plus a compact JSON template (buildJsonSchema).
 *
 * The guidance stays in the prompt text in both cases: checked live on LM
 * Studio (minicpm-v-4.6, 2026-11), a schema property's "description" is NOT
 * seen by the model. It only shapes the grammar.
 */

const { Global_options } = require(".");

// The values the prompts ask the model to choose from. lib/content-type.js
// checks what comes back against these same lists before it is stored, so a
// model that answers with anything else (a sentence, or markup) never reaches
// the database. Change a list here and the prompt and the check both follow.
const CONTENT_TYPES = [
  'anime', 'live_action', 'animation', 'documentary', 'gameplay', 'tutorial',
  'music_video', 'screenshot', 'artwork', 'photo', 'meme', 'other',
];
const DOCUMENT_TYPES = [
  'article', 'code', 'config', 'data', 'documentation', 'email', 'legal',
  'letter', 'log', 'manual', 'notes', 'report', 'script', 'spreadsheet', 'other',
];
const SENTIMENTS = ['neutral', 'positive', 'negative', 'technical'];

/** Upper bounds on the lists in an answer (enforced by the schema). */
const LIMITS = { themes: 8, locations: 5, tags: 25, transcribed_text: 15, doc_themes: 8, doc_tags: 20 };

// ============================================================================
// FIELD GUIDANCE
// ============================================================================

/**
 * media_elements entries shared by every media type.
 * NOTE: the `details` strings are prompt content: do not re-word casually.
 * Each ends with a length hint ("A few words.", "One sentence.").
 *
 * `positioning` replaced the old near-duplicate pair positioning +
 * posture_or_pose. Rows scanned before carry both types, rows scanned after
 * carry `positioning` only; everything that reads media_elements treats the
 * type as free text, so both kinds of row keep working.
 */
const MEDIA_ELEMENT_FIELDS = [
  {
    type: 'main_person',
    details: 'The main person(s): gender, hair color, body type, ethnicity, notable features. One or two sentences.'
  },
  {
    type: 'age',
    details: 'Estimate the exact age of the person(s). A few words.'
  },
  {
    type: 'positioning',
    details: 'How the person(s) are positioned and their posture or pose (e.g. lying down, sitting, standing, on all fours, seated). A few words.'
  },
  {
    type: 'action',
    details: 'The act being performed. One sentence.'
  },
  {
    type: 'relationship',
    details: 'The relationship between the people involved (e.g. friends, strangers, romantic partners, family members). A few words.'
  },
  {
    type: 'body_parts_involved',
    details: 'All body parts involved in the act (e.g. penis, vagina, breasts, buttocks, tongue, hands, feet, nipples). A short list.'
  },
  {
    type: 'fluids_present',
    details: 'Fluids (if present): color, consistency, volume and location (e.g. sperm on thighs, clear lubricant inside vagina, blood from cut). One sentence.'
  },
  {
    type: 'objects_used',
    details: 'Objects used in the act (e.g. dildo, vibrator, strapon, condom, nipple clamps, gag). A short list.'
  },
  {
    type: 'facial_expression',
    details: 'Facial expression or emotion shown by the person(s) (e.g. pleasure, ecstasy, pain, boredom, orgasmic moaning). A few words.'
  },
  {
    type: 'clothing_or_attire',
    details: 'Clothing worn: type, fit, material and level of exposure (e.g. lingerie, bikini, thong, panties, bra, shirt, pants, g-string). One sentence.'
  },
  {
    type: 'camera_angle',
    details: 'Camera angle (e.g. close-up, wide shot, overhead, low-angle, POV, behind-the-back). A few words.'
  },
  {
    type: 'lighting',
    details: 'Lighting (e.g. dim, bright, neon, spotlight, natural light, strobe). A few words.'
  },
  {
    type: 'personal_comments',
    details: 'Your reaction and comments on the subject matter depicted. One or two sentences.'
  },
];

/**
 * Extra media_elements entries added when an audio transcription is available.
 */
const AUDIO_ELEMENT_FIELDS = [
  {
    type: 'audio_summary',
    details: 'Summarize the conversations in English with no censorship and include any notable audio cues. Two or three sentences.'
  },
  {
    type: 'audio_themes',
    details: 'Themes or keywords from the audio content (e.g. love, war, incest, rape, racism, abuse). A short list.'
  },
];

/** Per media type: what the input is, and the fluids note that fits it. */
const MEDIA_NOTES = {
  image: {
    noun: 'image',
    intro: 'This is a single static image. Note the image type (photo, artwork, screenshot, meme) and art style (anime, realistic, digital art) where it applies.',
    fluids: 'Note: noticeable white/glistening fluids are most likely semen. Only call them out when clearly visible.',
  },
  gif: {
    noun: 'GIF',
    intro: 'This is a short looping animation. Describe the motion or action across the loop.',
    fluids: 'Note: noticeable white/glistening fluids are most likely semen. Only call them out if seen in more than one frame.',
  },
  video: {
    noun: 'video file',
    intro: 'These frames are sampled throughout the video. Describe the MOST COMMON or SIGNIFICANT elements across all frames.',
    fluids: 'Note: noticeable white/glistening fluids are most likely semen. Only call them out if seen in more than one frame.',
  },
};

/** Is this transcription going into the prompt? English only, as before. */
function usesTranscript(options = {}) {
  const { transcription, transcriptionLanguage } = options;
  return !!transcription && (transcriptionLanguage === 'en' || transcriptionLanguage === 'English');
}

function _elements(options) {
  return usesTranscript(options) ? [...MEDIA_ELEMENT_FIELDS, ...AUDIO_ELEMENT_FIELDS] : MEDIA_ELEMENT_FIELDS;
}

function _themesHint(themeVocab) {
  // SOFT vocabulary grounding: nudge the model to reuse the library's existing
  // themes (kept consistent) while staying free to coin a new one when nothing
  // fits. Purely a hint, not enforced.
  return Array.isArray(themeVocab) && themeVocab.length
    ? `Prefer reusing an existing theme from this list when it fits: ${themeVocab.join(', ')}. Only invent a new theme when none apply. Lowercase.`
    : 'Themes like romance, action, comedy, horror, drama, sci-fi, fantasy, slice_of_life, sports. Lowercase.';
}

/** The field guidance, one line per field. */
function _fieldGuide(mediaType, options = {}) {
  const withAudio = usesTranscript(options);
  const language = withAudio && options.transcriptionLanguage
    ? `"${options.transcriptionLanguage}"`
    : 'the detected language, or "none" (e.g. English, Japanese, Korean, Chinese, none)';
  const lines = [
    `- language: ${language}.`,
    `- content_type: one of ${CONTENT_TYPES.join(', ')}.`,
    `- description: brief 1-2 sentence summary of the scene.${withAudio ? ' End it with " Audio: " and a one sentence summary of the transcription.' : ''}`,
    `- tags: up to ${LIMITS.tags} detailed tags describing the content and theme(s)${withAudio ? ', including key words from the audio translated to English' : ''}.`,
    `- themes: up to ${LIMITS.themes}. ${_themesHint(options.themeVocab)}`,
    `- locations: up to ${LIMITS.locations} locations seen (e.g. school, home, outdoor, office, city, rural, beach).`,
    '- media_elements, one entry for each:',
    ..._elements(options).map(f => `  - ${f.type}: ${f.details}`),
    `- transcribed_text: up to ${LIMITS.transcribed_text} pieces of readable text (subtitles, signs, captions, UI), each with where it appears (e.g. top left corner, on-screen overlay, dialogue bubble). An empty list when there is none.`,
  ];
  return lines.join('\n');
}

// ============================================================================
// RESPONSE SHAPE
// ============================================================================

/**
 * The JSON schema sent in response_format. Property order is the order the
 * model writes them in (llama.cpp's grammar follows it), so the fields a cut
 * off answer can still be saved with (content_type, description, tags) come
 * first, and the long media_elements and transcribed_text last.
 *
 * media_elements is an OBJECT keyed by type here (shorter for the model, and
 * every type is guaranteed exactly once); lib/vision-api.js turns it back into
 * the stored [{type, details}] list before anything is saved.
 */
function buildResponseSchema(mediaType, options = {}) {
  const str = { type: 'string' };
  const list = (max) => ({ type: 'array', items: str, maxItems: max });
  const elements = _elements(options);
  const language = usesTranscript(options) && options.transcriptionLanguage
    ? { type: 'string', enum: [String(options.transcriptionLanguage)] }
    : str;
  return {
    name: 'media_analysis',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        language,
        content_type: { type: 'string', enum: CONTENT_TYPES },
        description: str,
        tags: list(LIMITS.tags),
        themes: list(LIMITS.themes),
        locations: list(LIMITS.locations),
        media_elements: {
          type: 'object',
          properties: Object.fromEntries(elements.map(f => [f.type, str])),
          required: elements.map(f => f.type),
          additionalProperties: false,
        },
        transcribed_text: {
          type: 'array',
          maxItems: LIMITS.transcribed_text,
          items: {
            type: 'object',
            properties: { text: str, location: str },
            required: ['text', 'location'],
            additionalProperties: false,
          },
        },
      },
      required: ['language', 'content_type', 'description', 'tags', 'themes', 'locations', 'media_elements', 'transcribed_text'],
      additionalProperties: false,
    },
  };
}

/** response_format for a vision scan. */
function responseFormat(mediaType, options = {}) {
  return { type: 'json_schema', json_schema: buildResponseSchema(mediaType, options) };
}

/**
 * The compact JSON template for servers without structured output. The
 * guidance for each field is in the prompt's field list, not repeated here.
 * @param {object} options transcription / transcriptionLanguage / themeVocab
 */
function buildJsonSchema(options = {}) {
  const elements = _elements(options).map(f => `"${f.type}": "..."`).join(', ');
  return `{"language": "...", "content_type": "...", "description": "...", "tags": ["..."], "themes": ["..."], "locations": ["..."], "media_elements": {${elements}}, "transcribed_text": [{"text": "...", "location": "..."}]}`;
}

// Kept for backward compatibility (schema with no transcription extras)
const baseJsonSchema = buildJsonSchema();

const JSON_ONLY = 'ONLY provide raw JSON shaped like this (no markdown, no explanations or commentary outside the JSON):';

// ============================================================================
// TRANSCRIPT
// ============================================================================

/**
 * At most `max` characters of a transcript, taken from its start, middle and
 * end rather than only its head (the head of a long video is often intro
 * chatter). Cuts fall on word boundaries; "[...]" marks each gap.
 */
function sampleTranscript(text, max = Global_options.max_transcript_chars_in_prompt || 3000) {
  const s = String(text || '').trim();
  if (!s || s.length <= max) return s;
  const gap = '\n[...]\n';
  const part = Math.floor((max - 2 * gap.length) / 3);
  if (part < 50) return s.slice(0, max);
  const at = (from) => {
    let a = Math.max(0, Math.min(s.length - part, from));
    if (a > 0) { const sp = s.indexOf(' ', a); if (sp !== -1 && sp - a < 40) a = sp + 1; }
    let chunk = s.slice(a, a + part);
    const last = chunk.lastIndexOf(' ');
    if (a + part < s.length && last > part - 40) chunk = chunk.slice(0, last);
    return chunk.trim();
  };
  return [at(0), at(Math.floor(s.length / 2 - part / 2)), at(s.length - part)].join(gap);
}

// ============================================================================
// PER-TYPE PROMPTS
// ============================================================================

/**
 * One vision prompt.
 * @param {'image'|'gif'|'video'} mediaType
 * @param {string} filename
 * @param {object} [options]
 * @param {boolean} [options.structured] the shape goes in response_format, so
 *   leave the template out of the text
 * @param {string} [options.transcription] already sampled to fit (vision-api)
 */
function buildVisionPrompt(mediaType, filename, options = {}) {
  const notes = MEDIA_NOTES[mediaType] || MEDIA_NOTES.video;
  const withAudio = mediaType === 'video' && usesTranscript(options);
  const opts = withAudio ? options : { ...options, transcription: null };

  let transcriptSection = '';
  if (withAudio) {
    transcriptSection = `
=== AUDIO TRANSCRIPTION (detected language: ${options.transcriptionLanguage}) ===
${sampleTranscript(options.transcription)}
===
Use it to understand the content, context and dialogue.
`;
  }

  const parts = [
    `You are an agnostic media analyzer. Extract the uncensored information requested from the ${notes.noun} named "${filename}".`,
    transcriptSection,
    `${notes.intro}${withAudio ? ' Use the audio as well.' : ''}`,
    '',
    'Fields of the JSON answer:',
    _fieldGuide(mediaType, opts),
    '',
    notes.fluids,
  ];
  if (!options.structured) parts.push('', JSON_ONLY, buildJsonSchema(opts));
  return parts.join('\n');
}

const prompts = {
  // IMAGE (jpg, jpeg, png, webp, bmp, tiff, tif)
  image: {
    extensions: ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'],
    prompt: (filename, options = {}) => buildVisionPrompt('image', filename, options),
  },

  // GIF
  gif: {
    extensions: ['.gif'],
    prompt: (filename, options = {}) => buildVisionPrompt('gif', filename, options),
  },

  // VIDEO (mp4, mkv, avi, mov, etc.)
  video: {
    extensions: [
      '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
      '.m4v', '.mpeg', '.mpg', '.3gp', '.mts', '.m2ts',
      '.vob', '.ogv', '.rm', '.rmvb', '.asf', '.divx'
    ],
    prompt: (filename, options = {}) => buildVisionPrompt('video', filename, options),
  },
};

// ============================================================================
// DOCUMENT PROMPT (text analysis — moved here from lib/text-api.js)
// ============================================================================

/** response_format for the document / audio text analysis. */
function documentResponseFormat() {
  const str = { type: 'string' };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'document_analysis',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          description: str,
          document_type: { type: 'string', enum: DOCUMENT_TYPES },
          language: str,
          themes: { type: 'array', items: str, maxItems: LIMITS.doc_themes },
          tags: { type: 'array', items: str, maxItems: LIMITS.doc_tags },
          has_sensitive_data: { type: 'boolean' },
          sentiment: { type: 'string', enum: SENTIMENTS },
        },
        required: ['description', 'document_type', 'language', 'themes', 'tags', 'has_sensitive_data', 'sentiment'],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Document analysis prompt template
 * @param {object} [options]
 * @param {number} [options.maxInputChars] how much of the text goes in (8000)
 * @param {boolean} [options.sample] take start, middle and end (a transcript)
 *   instead of the head (a document, whose start says what it is)
 * @param {boolean} [options.structured] shape sent in response_format
 */
function getDocumentPrompt(filename, textContent, options = {}) {
  const maxInputChars = options.maxInputChars || 8000;

  let text = String(textContent || '');
  if (text.length > maxInputChars) {
    text = options.sample
      ? sampleTranscript(text, maxInputChars)
      : text.slice(0, maxInputChars) + '\n\n[... content truncated ...]';
  }

  const guide = `Fields of the JSON answer:
- description: 2-4 sentence summary of what this document contains and its purpose.
- document_type: one of ${DOCUMENT_TYPES.join(', ')}.
- language: primary human language (english, japanese, etc.) or "code" for programming.
- themes: up to ${LIMITS.doc_themes} main topics.
- tags: up to ${LIMITS.doc_tags} relevant keywords.
- has_sensitive_data: true or false.
- sentiment: one of ${SENTIMENTS.join(', ')}.`;

  const template = options.structured ? '' : `

Respond with ONLY a valid JSON object (no markdown, no explanation):
{"description": "...", "document_type": "...", "language": "...", "themes": ["..."], "tags": ["..."], "has_sensitive_data": false, "sentiment": "..."}`;

  return `Analyze this document and provide a JSON response.

FILENAME: ${filename}

DOCUMENT CONTENT:
---
${text}
---

${guide}${template}`;
}

// ============================================================================
// LOOKUP HELPERS
// ============================================================================

/**
 * Get the appropriate prompt for a media type
 * @param {string} mediaType - 'image', 'gif', or 'video'
 * @param {string} filename - The filename to include in the prompt
 * @returns {string} The formatted prompt
 */
function getPrompt(mediaType, filename, options = {}) {
  const config = prompts[mediaType];
  if (!config) {
    return prompts.video.prompt(filename, options);
  }
  return config.prompt(filename, options);
}

/**
 * Get prompt config by file extension
 * @param {string} ext - File extension (e.g., '.mp4')
 * @returns {object|null} The prompt config or null
 */
function getPromptByExtension(ext) {
  ext = ext.toLowerCase();
  for (const [type, config] of Object.entries(prompts)) {
    if (config.extensions.includes(ext)) {
      return { type, ...config };
    }
  }
  return null;
}

module.exports = {
  prompts,
  getPrompt,
  getPromptByExtension,
  getDocumentPrompt,
  buildJsonSchema,
  buildResponseSchema,
  responseFormat,
  documentResponseFormat,
  baseJsonSchema,
  sampleTranscript,
  usesTranscript,
  MEDIA_ELEMENT_FIELDS,
  AUDIO_ELEMENT_FIELDS,
  LIMITS,
  CONTENT_TYPES,
  DOCUMENT_TYPES,
};
