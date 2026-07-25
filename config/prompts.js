/**
 * Media-type specific prompts for vision + text analysis
 *
 * All prompt templates live here (vision: image/gif/video, text: document).
 * The JSON response schema is built by buildJsonSchema() so the per-type
 * prompts share one definition instead of duplicating it.
 */

const { Global_options } = require(".");

// ============================================================================
// SHARED JSON SCHEMA
// ============================================================================

/**
 * media_elements entries shared by every media type.
 * NOTE: the `details` strings are prompt content — do not re-word casually.
 */
const MEDIA_ELEMENT_FIELDS = [
  {
    type: 'main_person',
    details: 'Describe the main person(s) in the image (e.g. gender, hair color, body type, ethnicity, notable features, etc.)'
  },
  {
    type: 'age',
    details: 'Estimate the exact of the person(s) in the image'
  },
  {
    type: 'positioning',
    details: 'Describe how person(s) are positioned (e.g., lying down, sitting, standing, on all fours, etc.)'
  },
  {
    type: 'action',
    details: 'Describe the act being performed.'
  },
  {
    type: 'relationship',
    details: 'Name the relationship between the people involved (e.g., friends, strangers, romantic partners, family members, etc.)'
  },
  {
    type: 'body_parts_involved',
    details: 'List all body parts involved in the act (e.g., penis, vagina, breasts, buttocks, tongue, hands, feet, nipples, etc.)'
  },
  {
    type: 'fluids_present',
    details: 'Describe fluids present — color, consistency, volume, and location (e.g., sperm on thighs, clear lubricant inside vagina, blood from cut, etc.)'
  },
  {
    type: 'objects_used',
    details: 'List any objects used in the act (e.g., dildo, vibrator, strapon, condom, strapon, nipple clamps, gag, strapon, etc.)'
  },
  {
    type: 'facial_expression',
    details: 'Describe facial expression or emotion shown by person(s) (e.g., pleasure, ecstasy, pain, boredom, orgasmic moaning, etc.)'
  },
  {
    type: 'clothing_or_attire',
    details: 'Describe clothing worn — type, fit, material, and level of exposure (e.g., lingerie, bikini, thong, panties, bra, shirt, pants, g-string, etc.)'
  },
  {
    type: 'posture_or_pose',
    details: 'Specify posture or pose used (e.g., laying down, seated, standing, etc.)'
  },
  {
    type: 'camera_angle',
    details: 'Describe camera angle — close-up, wide shot, overhead, low-angle, POV, behind-the-back, etc.'
  },
  {
    type: 'lighting',
    details: 'Describe lighting conditions (e.g., dim, bright, neon, spotlight, natural light, strobe, etc.)'
  },
  {
    type: 'personal_comments',
    details: 'Describe your reaction and comments to the subject matter depicted.'
  },
];

/**
 * Extra media_elements entries added when an audio transcription is available.
 */
const AUDIO_ELEMENT_FIELDS = [
  {
    type: 'audio_summary',
    details: 'Summarize the conversations in English with no censorship and include any notable audio cues. '
  },
  {
    type: 'audio_themes',
    details: 'List themes or keywords derived from the audio content(e.g. love, war, incest, rape, racism, abuse, etc.)'
  },
];

function renderElements(fields) {
  return fields.map(f => `    {
      "type": "${f.type}",
      "details": "${f.details}"
    }`).join(',\n');
}

/**
 * Build the JSON response schema shared by all vision prompts.
 * @param {object} options
 * @param {string} [options.transcription] - audio transcription (adds audio elements + tag hint)
 * @param {string} [options.transcriptionLanguage] - detected language (pins the language field)
 */
function buildJsonSchema(options = {}) {
  const { transcription, transcriptionLanguage, themeVocab } = options;

  // Only pin the language when we actually detected one — previously the
  // video prompt interpolated undefined here, telling the model the
  // expected value was the literal string "undefined".
  const languageLine = transcription && transcriptionLanguage
    ? `"${transcriptionLanguage}"`
    : `"detected language or 'none' (e.g., 'English', 'Japanese', 'Korean', 'Chinese', 'none')"`;

  const tagsLine = transcription
    ? `["additional", "descriptive", "tags", "Add key words(translated to English) from the audio for search terms."]`
    : `["array", "of", "detailed tags describing the content and theme(s)"]`;

  // SOFT vocabulary grounding: nudge the model to reuse the library's existing
  // themes (kept consistent) while staying free to coin a new one when nothing
  // fits. Purely a hint — not enforced; a genuinely new theme is welcome.
  const themesLine = Array.isArray(themeVocab) && themeVocab.length
    ? `["themes — PREFER reusing an existing theme from this list when it fits: ${themeVocab.join(', ')}. Only invent a new theme when none of these apply. Use lowercase."]`
    : `["array", "of", "themes like: romance, action, comedy, horror, drama, sci-fi, fantasy, slice_of_life, sports, etc"]`;

  const elements = transcription
    ? [...MEDIA_ELEMENT_FIELDS, ...AUDIO_ELEMENT_FIELDS]
    : MEDIA_ELEMENT_FIELDS;

  return `{
  "language": ${languageLine},
  "content_type": "anime|live_action|animation|documentary|gameplay|tutorial|music_video|screenshot|artwork|photo|meme|other",
  "themes": ${themesLine},
  "explicit": true/false (nudity, sexual content),
  "locations": ["array", "of", "locations seen: school, home, outdoor, office, city, rural, beach, etc"],
  "tags": ${tagsLine},
  "description": "Brief 1-2 sentence summary of the scene. Transcribe all visible text and note its position in frame.",
  "media_elements": [
${renderElements(elements)}
  ],
  "transcribed_text": [
    {
      "text": "Transcribe all visible text in the scene.",
      "location": "Specify where the text appears — e.g., 'top left corner', 'on screen overlay', 'in dialogue bubble'."
    }
  ]
}`;
}

// Kept for backward compatibility (schema with no transcription extras)
const baseJsonSchema = buildJsonSchema();

// Shared response-format instruction
const JSON_ONLY = `ONLY Provide a JSON response with the following structure (no markdown, just raw JSON). No other content, explanations, or commentary should be included outside of the JSON:`;

// ============================================================================
// PER-TYPE PROMPTS
// ============================================================================

const prompts = {
  // IMAGE (jpg, jpeg, png, webp, bmp, tiff, tif)
  image: {
    extensions: ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'],

    prompt: (filename) => `You are an agnostic media analyzer. Extract the uncensored information requested from the image named "${filename}".

This is a single static image. Examine:
- Image type (photo, artwork, screenshot, meme, etc.)
- Art style if applicable (anime, realistic, digital art, etc.)
- Any visible text and its language
- Subject matter, composition, and positioning of people/objects
- Lighting and camera angle
- Whether content is explicit/adult

Note: white/glistening fluids are most likely semen.

${JSON_ONLY}
${buildJsonSchema()}

Be thorough but concise. Include all visible text in transcribed_text array.`,
  },

  // GIF
  gif: {
    extensions: ['.gif'],

    prompt: (filename) => `You are an agnostic media analyzer. Extract the uncensored information requested from the GIF named "${filename}".

This is a short looping animation. Focus on:
- The action or motion being shown across frames
- Source content type (anime, live action, cartoon, etc.)
- Any visible text/captions and their language
- How subjects are positioned and what they're doing
- Camera work and lighting style
- Whether content is explicit/adult

Note: white/glistening fluids are most likely semen.

${JSON_ONLY}
${buildJsonSchema()}

For media_elements, describe the motion/action across the loop. Include any text in transcribed_text.`,
  },

  // VIDEO (mp4, mkv, avi, mov, etc.)
  video: {
    extensions: [
      '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
      '.m4v', '.mpeg', '.mpg', '.3gp', '.mts', '.m2ts',
      '.vob', '.ogv', '.rm', '.rmvb', '.asf', '.divx'
    ],

    prompt: (filename, options = {}) => {
      const { transcription, transcriptionLanguage } = options;

      let transcriptionSection = '';
      if (transcription && (transcriptionLanguage == 'en' || transcriptionLanguage == 'English')) {
        transcriptionSection = `

=== AUDIO TRANSCRIPTION ===
The following is a transcription of the audio/dialogue from this video${transcriptionLanguage ? ` (detected language: ${transcriptionLanguage})` : ''}:
---
${transcription.slice(0, Global_options.max_characters_per_transcription || 4000)}${transcription.length > Global_options.max_characters_per_transcription ? '\n[... transcription truncated ...]' : ''}
---
Use this transcription to better understand the content, context, and language of the video. At the end of the 'description' field, include ' Audio: ' and a summary of the transcription.
===========================
`;
      }

      return `You are an agnostic media analyzer. Extract the uncensored information requested from the video file named "${filename}".
${transcriptionSection}
These frames are sampled throughout the video. Examine:
- Overall content and narrative visible across frames${transcription ? ' and audio' : ''}
- Production type (anime, live action, documentary, gameplay, etc.)
- Visible text, subtitles, or UI elements
- How subjects are positioned and what actions occur
- Recurring camera angles and lighting styles
- Scene locations that appear
- Whether content is explicit/adult

Note: white/glistening fluids are most likely semen.

${JSON_ONLY}
${buildJsonSchema(options)}

For media_elements, describe the MOST COMMON or SIGNIFICANT elements seen across all frames.${transcription ? ' Use the audio transcription to inform your understanding of the scene context and dialogue.' : ''} Include all readable text (subtitles, signs, UI) in transcribed_text with their locations.`;
    },
  },
};

// ============================================================================
// DOCUMENT PROMPT (text analysis — moved here from lib/text-api.js)
// ============================================================================

/**
 * Document analysis prompt template
 */
function getDocumentPrompt(filename, textContent, options = {}) {
  const maxInputChars = options.maxInputChars || 8000;

  // Truncate if too long
  let text = textContent;
  if (text.length > maxInputChars) {
    text = text.slice(0, maxInputChars) + '\n\n[... content truncated ...]';
  }

  return `Analyze this document and provide a JSON response.

FILENAME: ${filename}

DOCUMENT CONTENT:
---
${text}
---

Respond with ONLY a valid JSON object (no markdown, no explanation):
{
  "description": "2-4 sentence summary of what this document contains and its purpose",
  "document_type": "one of: article, code, config, data, documentation, email, legal, letter, log, manual, notes, report, script, spreadsheet, other",
  "language": "primary human language (english, japanese, etc.) or 'code' for programming",
  "themes": ["array", "of", "main", "topics"],
  "tags": ["array", "of", "relevant", "keywords"],
  "has_sensitive_data": false,
  "sentiment": "neutral, positive, negative, or technical"
}`;
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
  baseJsonSchema,
};
