// Elements
const apiUrlInput = document.getElementById('apiUrl');
const targetLangSelect = document.getElementById('targetLang');
const sourceLangSelect = document.getElementById('sourceLang');
const speedModeSelect = document.getElementById('speedMode');
const translateBtn = document.getElementById('translateBtn');
const restoreBtn = document.getElementById('restoreBtn');
const statusSection = document.getElementById('statusSection');
const statusMessage = document.getElementById('statusMessage');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const settingsBtn = document.getElementById('settingsBtn');
const apiSection = document.getElementById('apiSection');
const textInput = document.getElementById('textInput');
const textResult = document.getElementById('textResult');
const translateTextBtn = document.getElementById('translateTextBtn');
const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

let history = [];

// Load saved settings
chrome.storage.local.get(['apiUrl', 'targetLang', 'sourceLang', 'speed', 'history', 'hoverTranslate', 'selectionTranslate'], (data) => {
  apiUrlInput.value = data.apiUrl || 'http://127.0.0.1:8088';
  targetLangSelect.value = data.targetLang || 'en';
  sourceLangSelect.value = data.sourceLang || 'auto';
  speedModeSelect.value = data.speed || '500';
  history = data.history || [];
  
  // Load toggle states
  if (data.hoverTranslate) document.getElementById('hoverTranslate').classList.add('active');
  if (data.selectionTranslate !== false) document.getElementById('selectionTranslate').classList.add('active');
  
  renderHistory();
  
  // Check auto-translate status for current site
  checkAutoTranslateStatus();
});

// Save settings on change
apiUrlInput.addEventListener('change', () => chrome.storage.local.set({ apiUrl: apiUrlInput.value }));
targetLangSelect.addEventListener('change', () => chrome.storage.local.set({ targetLang: targetLangSelect.value }));
sourceLangSelect.addEventListener('change', () => chrome.storage.local.set({ sourceLang: sourceLangSelect.value }));
speedModeSelect.addEventListener('change', () => chrome.storage.local.set({ speed: speedModeSelect.value }));

// Toggle switches (except autoTranslate which is per-site)
document.querySelectorAll('.toggle:not(#autoTranslate)').forEach(toggle => {
  toggle.addEventListener('click', () => {
    toggle.classList.toggle('active');
    const key = toggle.dataset.key;
    if (key) {
      chrome.storage.local.set({ [key]: toggle.classList.contains('active') });
    }
  });
});

// Auto-translate toggle (per-site)
const autoTranslateToggle = document.getElementById('autoTranslate');
autoTranslateToggle.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const newState = !autoTranslateToggle.classList.contains('active');
  
  chrome.tabs.sendMessage(tab.id, {
    action: 'toggleAutoTranslate',
    enabled: newState
  }, (response) => {
    if (response?.success) {
      autoTranslateToggle.classList.toggle('active', newState);
    }
  });
});

async function checkAutoTranslateStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'checkAutoTranslate' }, (response) => {
      if (response?.enabled) {
        document.getElementById('autoTranslate').classList.add('active');
      } else {
        document.getElementById('autoTranslate').classList.remove('active');
      }
    });
  } catch {}
}

// Settings toggle
settingsBtn.addEventListener('click', () => apiSection.classList.toggle('show'));

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

function showStatus(message, type) {
  statusSection.classList.add('show');
  statusText.className = `status-text ${type}`;
  const icons = { loading: '⏳', success: '✅', error: '❌', warning: '⚠️' };
  statusIcon.textContent = icons[type] || '💬';
  statusMessage.textContent = message;
}

// Add to history
function addToHistory(source, result, sourceLang, targetLang) {
  history.unshift({
    source: source.substring(0, 100),
    result: result.substring(0, 100),
    sourceLang,
    targetLang,
    time: Date.now()
  });
  if (history.length > 50) history.pop();
  chrome.storage.local.set({ history });
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) {
    historyList.innerHTML = '<div class="text-result empty">No translation history yet</div>';
    return;
  }
  
  historyList.innerHTML = history.map((item, i) => `
    <div class="history-item" data-index="${i}">
      <div class="history-item-source">${item.sourceLang} → ${item.targetLang}</div>
      <div class="history-item-text">${item.source} → ${item.result}</div>
    </div>
  `).join('');
  
  // Click to copy
  historyList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index);
      navigator.clipboard.writeText(history[idx].result);
      showStatus('Copied to clipboard!', 'success');
    });
  });
}

clearHistoryBtn.addEventListener('click', () => {
  history = [];
  chrome.storage.local.set({ history: [] });
  renderHistory();
  showStatus('History cleared', 'success');
});

// Translate page
translateBtn.addEventListener('click', async () => {
  const apiUrl = apiUrlInput.value.replace(/\/$/, '');
  const targetLang = targetLangSelect.value;
  const concurrency = parseInt(speedModeSelect.value);
  
  translateBtn.disabled = true;
  showStatus('Collecting text...', 'loading');
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
      showStatus('Cannot translate this page', 'error');
      translateBtn.disabled = false;
      return;
    }
    
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] }).catch(() => {});
    
    const collectResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [targetLang],
      func: collectTexts
    });
    
    const { texts } = collectResult[0]?.result || { texts: [] };
    
    if (!texts.length) {
      showStatus('Nothing to translate', 'success');
      translateBtn.disabled = false;
      return;
    }
    
    showStatus(`Translating ${texts.length} items...`, 'loading');
    
    // Show non-intrusive indicator
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [texts.length],
      func: (total) => {
        let indicator = document.getElementById('translator-indicator');
        if (!indicator) {
          indicator = document.createElement('div');
          indicator.id = 'translator-indicator';
          indicator.innerHTML = `
            <div class="spinner"></div>
            <div class="progress">
              <div class="progress-text">Translating <span class="count">0</span>/${total}</div>
              <div class="progress-bar-bg">
                <div class="progress-bar" style="width: 0%"></div>
              </div>
            </div>
            <button class="close-btn" title="Hide">×</button>
          `;
          document.body.appendChild(indicator);
          indicator.querySelector('.close-btn').addEventListener('click', () => {
            indicator.classList.remove('show');
          });
        }
        indicator.querySelector('.progress-text').innerHTML = `Translating <span class="count">0</span>/${total}`;
        indicator.querySelector('.progress-bar').style.width = '0%';
        indicator.classList.add('show');
      }
    });
    
    const response = await chrome.runtime.sendMessage({
      action: 'translateBatch',
      apiUrl,
      targetLang,
      texts,
      concurrency,
      tabId: tab.id
    });
    
    if (!response.success) throw new Error(response.error);
    
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [response.results],
      func: (results) => {
        const nodes = window.__translatorNodes || [];
        nodes.forEach((node, i) => {
          if (results[i] && node.parentElement) {
            node.textContent = results[i];
          }
        });
        // Hide indicator with success message
        const indicator = document.getElementById('translator-indicator');
        if (indicator) {
          indicator.querySelector('.progress-text').textContent = 'Done!';
          indicator.querySelector('.progress-bar').style.width = '100%';
          setTimeout(() => indicator.classList.remove('show'), 1500);
        }
      }
    });
    
    showStatus(`Translated ${texts.length} elements`, 'success');
  } catch (e) {
    showStatus(e.message, 'error');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ 
      target: { tabId: tab.id }, 
      func: () => {
        document.getElementById('translator-indicator')?.classList.remove('show');
      }
    }).catch(() => {});
  }
  
  translateBtn.disabled = false;
});

// Restore page
restoreBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: restorePage });
    showStatus('Restored original text', 'success');
  } catch (e) {
    showStatus(e.message, 'error');
  }
});

// Translate text input
translateTextBtn.addEventListener('click', async () => {
  const text = textInput.value.trim();
  if (!text) {
    showStatus('Enter text to translate', 'warning');
    return;
  }
  
  const apiUrl = apiUrlInput.value.replace(/\/$/, '');
  const targetLang = targetLangSelect.value;
  const sourceLang = sourceLangSelect.value;
  
  translateTextBtn.disabled = true;
  textResult.textContent = 'Translating...';
  textResult.classList.remove('empty');
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'translate',
      apiUrl,
      targetLang,
      text
    });
    
    if (!response.success) throw new Error(response.error);
    
    textResult.textContent = response.result;
    addToHistory(text, response.result, sourceLang, targetLang);
    showStatus('Text translated', 'success');
  } catch (e) {
    textResult.textContent = 'Error: ' + e.message;
    showStatus(e.message, 'error');
  }
  
  translateTextBtn.disabled = false;
});

// More button - open options or show info
document.getElementById('moreBtn').addEventListener('click', () => {
  showStatus('Page Translator v1.0.0 - Powered by Google Translate', 'warning');
});


// Page context functions
function collectTexts(targetLang) {
  const LANG_PATTERNS = {
    'zh': /[\u4e00-\u9fa5]/,
    'ja': /[\u3040-\u309f\u30a0-\u30ff]/,
    'ko': /[\uac00-\ud7af\u1100-\u11ff]/,
    'ar': /[\u0600-\u06ff]/,
    'ru': /[\u0400-\u04ff]/,
    'th': /[\u0e00-\u0e7f]/,
    'hi': /[\u0900-\u097f]/,
  };

  function detectLang(text) {
    for (const [lang, pattern] of Object.entries(LANG_PATTERNS)) {
      if (pattern.test(text)) return lang;
    }
    return 'en';
  }

  function needsTranslation(text, target) {
    return detectLang(text) !== target.split('-')[0];
  }

  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (['script', 'style', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      const text = node.textContent.trim();
      if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  
  let node;
  while (node = walker.nextNode()) nodes.push(node);
  
  window.__translatorNodes = [];
  window.__originalTexts = window.__originalTexts || new Map();
  const texts = [];
  
  for (const n of nodes) {
    const text = n.textContent.trim();
    if (needsTranslation(text, targetLang)) {
      window.__translatorNodes.push(n);
      texts.push(text);
      if (!window.__originalTexts.has(n)) {
        window.__originalTexts.set(n, n.textContent);
      }
    }
  }
  
  return { texts };
}

function showOverlay(total) {
  let overlay = document.getElementById('translator-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'translator-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="translator-spinner"></div><div>Translating ${total} items...</div>`;
  overlay.classList.add('show');
}

function hideOverlay() {
  document.getElementById('translator-overlay')?.classList.remove('show');
}

function applyTranslations(results) {
  const nodes = window.__translatorNodes || [];
  nodes.forEach((node, i) => {
    if (results[i] && node.parentElement) {
      node.textContent = results[i];
    }
  });
  document.getElementById('translator-overlay')?.classList.remove('show');
}

function restorePage() {
  if (window.__originalTexts) {
    window.__originalTexts.forEach((original, node) => {
      if (node.parentElement) node.textContent = original;
    });
    window.__originalTexts.clear();
  }
  window.__translatorNodes = [];
}
