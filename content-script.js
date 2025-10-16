// content-script.js - nasłuchuje wiadomości z injected script i wysyła przez XHR
console.log('📡 Content script załadowany na ChatGPT');

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbxM9dGsIZqg56ttKRiZ2zu51A9PseWL98d19rp93UCErjYJgk-8eqwPIhlj0UhoOXK-/exec';
const AUTH_TOKEN = 'economist-chatgpt-2024';

// Nasłuchuj wiadomości z injected script
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  
  if (event.data.type === 'ECONOMIST_TO_SHEETS') {
    console.log('📨 Content script otrzymał dane:', event.data.data);
    
    // Wyślij bezpośrednio do Google Sheets przez XMLHttpRequest
    try {
      await sendToSheetsWithRetry(event.data.data);
      
      // Powiadom background o sukcesie (dla notyfikacji)
      chrome.runtime.sendMessage({
        type: 'SHEETS_SUCCESS',
        data: event.data.data
      });
      
    } catch (error) {
      console.error('❌ Błąd wysyłania do Sheets:', error);
      
      // Powiadom background o błędzie (dla notyfikacji)
      chrome.runtime.sendMessage({
        type: 'SHEETS_ERROR',
        error: error.message
      });
    }
  }
});

// Funkcja wysyłania z retry
async function sendToSheetsWithRetry(data) {
  const MAX_RETRIES = 3;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`📤 Próba ${attempt}/${MAX_RETRIES}...`);
      
      const result = await sendWithXHR(data);
      console.log('✅ Sukces:', result);
      return result;
      
    } catch (error) {
      console.error(`❌ Próba ${attempt} nieudana:`, error);
      
      if (attempt === MAX_RETRIES) {
        throw error;
      }
      
      // Exponential backoff
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// Funkcja wysyłania przez XHR (działa w content script!)
function sendWithXHR(data) {
  return new Promise((resolve, reject) => {
    const truncatedResponse = data.response.substring(0, 5000);
    
    const params = new URLSearchParams({
      response: truncatedResponse,
      timestamp: data.timestamp,
      source: data.source,
      auth: AUTH_TOKEN
    });
    
    const url = `${SHEETS_URL}?${params}`;
    console.log('🔗 URL:', url.substring(0, 150) + '...');
    
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 15000;
    
    xhr.onload = () => {
      console.log('📥 Status:', xhr.status);
      console.log('📥 Response:', xhr.responseText);
      
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(xhr.responseText);
          resolve(result);
        } catch (e) {
          resolve(xhr.responseText);
        }
      } else {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    };
    
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.ontimeout = () => reject(new Error('Timeout'));
    
    xhr.send();
  });
}

// Powiadom injected script że jesteśmy gotowi
window.postMessage({ type: 'CONTENT_SCRIPT_READY' }, '*');
