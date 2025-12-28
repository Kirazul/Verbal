// Page Translator - Content Script
// Handles: auto-translate, selection translate, Alt+A shortcut

(function() {
  // Prevent double-loading
  if (window.__pageTranslatorLoaded) return;
  window.__pageTranslatorLoaded = true;
  
  // State
  let config = {
    apiUrl: 'http://127.0.0.1:8088',
    targetLang: 'en',
    speed: 500,
    selectionTranslate: true,
    autoTranslateSites: []
  };
  
  let isTranslating = false;
  let observer = null;
  let debounceTimer = null;
  
  // Track what we've translated to avoid re-translating
  const translatedNodes = new WeakSet();
  const originalTexts = new WeakMap();
  
  const currentHost = window.location.hostname;
  
  // Load config
  chrome.storage.local.get(['apiUrl', 'targetLang', 'speed', 'selectionTranslate', 'autoTranslateSites'], data => {
    config.apiUrl = data.apiUrl || config.apiUrl;
    config.targetLang = data.targetLang || config.targetLang;
    config.speed = parseInt(data.speed) || config.speed;
    config.selectionTranslate = data.selectionTranslate !== false;
    config.autoTranslateSites = data.autoTranslateSites || [];
    
    // Auto-translate if this site is in the list
    if (config.autoTranslateSites.includes(currentHost)) {
      setTimeout(translatePage, 2000);
      setupObserver();
    }
  });
  
  // Listen for config changes
  chrome.storage.onChanged.addListener(changes => {
    if (changes.apiUrl) config.apiUrl = changes.apiUrl.newValue;
    if (changes.targetLang) config.targetLang = changes.targetLang.newValue;
    if (changes.speed) config.speed = parseInt(changes.speed.newValue) || 500;
    if (changes.selectionTranslate) config.selectionTranslate = changes.selectionTranslate.newValue;
    if (changes.autoTranslateSites) {
      config.autoTranslateSites = changes.autoTranslateSites.newValue || [];
      if (config.autoTranslateSites.includes(currentHost)) {
        setupObserver();
      } else {
        removeObserver();
      }
    }
  });
  
  // Handle messages from popup
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.action === 'checkAutoTranslate') {
      respond({ enabled: config.autoTranslateSites.includes(currentHost), host: currentHost });
    }
    if (msg.action === 'toggleAutoTranslate') {
      if (msg.enabled) {
        if (!config.autoTranslateSites.includes(currentHost)) {
          config.autoTranslateSites.push(currentHost);
        }
        chrome.storage.local.set({ autoTranslateSites: config.autoTranslateSites });
        setupObserver();
        translatePage();
      } else {
        config.autoTranslateSites = config.autoTranslateSites.filter(h => h !== currentHost);
        chrome.storage.local.set({ autoTranslateSites: config.autoTranslateSites });
        removeObserver();
      }
      respond({ success: true });
    }
    return true;
  });
  
  // Language detection
  const langPatterns = {
    zh: /[\u4e00-\u9fa5]/,
    ja: /[\u3040-\u30ff]/,
    ko: /[\uac00-\ud7af]/,
    ar: /[\u0600-\u06ff]/,
    ru: /[\u0400-\u04ff]/,
    th: /[\u0e00-\u0e7f]/,
    hi: /[\u0900-\u097f]/
  };
  
  function detectLang(text) {
    for (const [lang, re] of Object.entries(langPatterns)) {
      if (re.test(text)) return lang;
    }
    return 'en';
  }
  
  function needsTranslation(text) {
    const detected = detectLang(text);
    const target = config.targetLang.split('-')[0];
    return detected !== target;
  }
  
  // Check if element is our UI
  function isOurElement(el) {
    while (el) {
      if (el.id === 'translator-indicator' || el.id === 'translator-tooltip') return true;
      el = el.parentElement;
    }
    return false;
  }
  
  // Get text nodes that need translation
  function getTextNodes() {
    const result = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (translatedNodes.has(node)) return NodeFilter.FILTER_REJECT;
        
        const parent = node.parentElement;
        if (!parent || isOurElement(parent)) return NodeFilter.FILTER_REJECT;
        
        const tag = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'code', 'pre', 'input', 'textarea'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        try {
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }
        } catch { return NodeFilter.FILTER_REJECT; }
        
        const text = node.textContent.trim();
        if (!text || text.length < 2 || !needsTranslation(text)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    
    let node;
    while (node = walker.nextNode()) result.push(node);
    return result;
  }
  
  // Main translate function
  async function translatePage() {
    if (isTranslating) return;
    isTranslating = true;
    
    const nodes = getTextNodes();
    if (nodes.length === 0) {
      isTranslating = false;
      return;
    }
    
    // Save originals
    const texts = nodes.map(n => {
      if (!originalTexts.has(n)) originalTexts.set(n, n.textContent);
      return n.textContent.trim();
    });
    
    // Store for popup's use
    window.__translatorNodes = nodes;
    window.__originalTexts = originalTexts;
    
    showIndicator(texts.length);
    
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'translateBatch',
        apiUrl: config.apiUrl,
        targetLang: config.targetLang,
        texts,
        concurrency: config.speed
      });
      
      if (response?.success && response.results) {
        nodes.forEach((node, i) => {
          if (response.results[i] && node.parentElement) {
            node.textContent = response.results[i];
            translatedNodes.add(node);
          }
        });
        hideIndicator(true);
      } else {
        hideIndicator(false);
      }
    } catch (e) {
      console.error('Translation error:', e);
      hideIndicator(false);
    }
    
    isTranslating = false;
  }
  
  // Observer for dynamic content
  function setupObserver() {
    if (observer) return;
    
    observer = new MutationObserver(mutations => {
      if (isTranslating) return;
      
      // Check if any real content was added (not our elements)
      let hasNew = false;
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && !isOurElement(n)) {
            hasNew = true;
            break;
          }
        }
        if (hasNew) break;
      }
      
      if (hasNew) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (!isTranslating) translatePage();
        }, 3000);
      }
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
  }
  
  function removeObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(debounceTimer);
  }
  
  // UI: Indicator
  function showIndicator(total) {
    document.getElementById('translator-indicator')?.remove();
    
    const el = document.createElement('div');
    el.id = 'translator-indicator';
    el.innerHTML = `
      <div class="progress">
        <div class="progress-text"><span class="count">0</span>/<span class="total">${total}</span></div>
        <div class="progress-bar-bg"><div class="progress-bar"></div></div>
      </div>
      <button class="close-btn">×</button>
    `;
    el.querySelector('.close-btn').onclick = () => el.remove();
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
  }
  
  function hideIndicator(success) {
    const el = document.getElementById('translator-indicator');
    if (!el) return;
    
    el.classList.add(success ? 'done' : 'error');
    el.querySelector('.progress-bar').style.width = '100%';
    
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 1000);
  }
  
  // UI: Tooltip
  function showTooltip(text, x, y) {
    document.getElementById('translator-tooltip')?.remove();
    
    const el = document.createElement('div');
    el.id = 'translator-tooltip';
    el.textContent = text;
    el.style.left = Math.min(x, window.innerWidth - 300) + 'px';
    el.style.top = y + 'px';
    document.body.appendChild(el);
    
    setTimeout(() => el.remove(), 5000);
  }
  
  // Translate single text
  async function translateSingle(text) {
    const response = await chrome.runtime.sendMessage({
      action: 'translate',
      apiUrl: config.apiUrl,
      targetLang: config.targetLang,
      text
    });
    if (response?.success) return response.result;
    throw new Error(response?.error || 'Failed');
  }
  
  // Keyboard: Alt+A
  document.addEventListener('keydown', e => {
    if (e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (!isTranslating) translatePage();
    }
  });
  
  // Selection translation
  document.addEventListener('mouseup', e => {
    if (!config.selectionTranslate) return;
    if (isOurElement(e.target)) return;
    
    const text = window.getSelection().toString().trim();
    if (!text || text.length < 2 || text.length > 500) return;
    
    setTimeout(() => {
      translateSingle(text)
        .then(result => showTooltip(result, e.clientX, e.clientY + 15))
        .catch(() => {});
    }, 50);
  });
  
  // Click dismisses tooltip
  document.addEventListener('click', e => {
    if (!e.target.closest('#translator-tooltip')) {
      document.getElementById('translator-tooltip')?.remove();
    }
  });
})();
