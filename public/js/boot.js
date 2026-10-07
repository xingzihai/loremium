document.addEventListener('alpine:init', () => {
  window.Alpine.data('admin', () => window.__loremiumAdmin || {})
})
