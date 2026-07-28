/* =========================================================================
   MODAL - Detail modal for viewing media info -- default view.

   The body itself comes from renderDetailBody (player-lib/detail-view.js),
   which the player sidebar also uses, so the two surfaces cannot drift apart
   again. Only the title bar and overlay plumbing live here.
   ========================================================================= */

function showDetails(media) {
  document.getElementById('modalTitle').textContent = media.filename;
  document.getElementById('modalBody').innerHTML = renderDetailBody(media, { context: 'library' });
  document.getElementById('modalOverlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modalOverlay').classList.remove('active');
  document.body.style.overflow = '';
  // Don't lose a half-typed note, then drop the markup: the Subtitles/Music
  // sections fill themselves in by element id, and the player sidebar renders
  // the same ids — a hidden leftover copy would shadow the live one.
  if (typeof flushPendingNotes === 'function') flushPendingNotes();
  document.getElementById('modalBody').innerHTML = '';
}
