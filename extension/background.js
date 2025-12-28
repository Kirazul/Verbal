// Background service worker - bypasses ad blockers

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'translate') {
    translateText(request.apiUrl, request.targetLang, request.text)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  
  if (request.action === 'translateBatch') {
    // Get tab ID from request (popup) or sender (content script)
    const tabId = request.tabId || sender.tab?.id;
    translateBatchWithProgress(request.apiUrl, request.targetLang, request.texts, request.concurrency, tabId)
      .then(results => sendResponse({ success: true, results }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function translateText(apiUrl, targetLang, text) {
  const response = await fetch(`${apiUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google-translate',
      source_lang: 'auto',
      target_lang: targetLang,
      messages: [{ role: 'user', content: text }]
    })
  });
  
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n')) {
      if (line.startsWith('data: ') && !line.includes('[DONE]')) {
        try {
          result += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '';
        } catch {}
      }
    }
  }
  return result.trim();
}

async function translateBatchWithProgress(apiUrl, targetLang, texts, concurrency = 500, tabId) {
  const results = new Array(texts.length);
  let completed = 0;
  
  const updateProgress = async () => {
    if (!tabId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        args: [completed, texts.length],
        func: (done, total) => {
          const indicator = document.getElementById('translator-indicator');
          if (indicator) {
            const pct = Math.round((done / total) * 100);
            const countEl = indicator.querySelector('.count');
            const barEl = indicator.querySelector('.progress-bar');
            if (countEl) countEl.textContent = done;
            if (barEl) barEl.style.width = pct + '%';
          }
        }
      });
    } catch (e) {
      // Ignore errors
    }
  };
  
  const translateOne = async (index) => {
    try {
      results[index] = await translateText(apiUrl, targetLang, texts[index]);
    } catch {
      results[index] = null;
    }
    completed++;
    
    // Update progress on every item for real-time feedback
    updateProgress();
  };
  
  // Process in parallel batches
  for (let i = 0; i < texts.length; i += concurrency) {
    const batch = [];
    for (let j = i; j < Math.min(i + concurrency, texts.length); j++) {
      batch.push(translateOne(j));
    }
    await Promise.all(batch);
  }
  
  return results;
}
