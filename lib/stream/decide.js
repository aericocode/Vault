/**
 * The playback decision matrix lives in player-lib/playback-decide.js so the
 * browser and the server share one copy: the extension chips and the tile
 * warnings run the same function the routes do. This file only re-exports it,
 * so every existing `require('./decide')` keeps working.
 */
module.exports = require('../../player-lib/playback-decide.js');
