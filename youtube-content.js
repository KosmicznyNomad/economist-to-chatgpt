// YouTube Content Script - przechwytuje i pobiera transkrypcje
// Automatycznie ładowany na wszystkich stronach YouTube

console.log('[YouTube Content Script] Initialized');

// === 1. CAPTURE ytInitialPlayerResponse ===
function captureYouTubeData() {
  console.log('[YouTube Content Script] Capturing YouTube data...');
  
  try {
    // Wyciągnij Video ID z URL
    const videoId = extractVideoId(window.location.href);
    if (!videoId) {
      console.log('[YouTube Content Script] No video ID in URL');
      window._ytTranscriptData = null;
      return;
    }
    
    console.log(`[YouTube Content Script] Video ID: ${videoId}`);
    
    // Spróbuj różne metody wyciągnięcia ytInitialPlayerResponse
    let ytInitialPlayerResponse = null;
    
    // Metoda 1: window.ytInitialPlayerResponse (może być dostępne globalnie)
    if (window.ytInitialPlayerResponse) {
      console.log('[YouTube Content Script] ✓ Znaleziono window.ytInitialPlayerResponse');
      ytInitialPlayerResponse = window.ytInitialPlayerResponse;
    }
    
    // Metoda 2: Szukaj w <script> tagach
    if (!ytInitialPlayerResponse) {
      console.log('[YouTube Content Script] Szukam w <script> tagach...');
      const scripts = document.querySelectorAll('script');
      
      for (const script of scripts) {
        const content = script.textContent || script.innerText || '';
        
        // Wzorzec 1: var ytInitialPlayerResponse = {...};
        let match = content.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
        
        // Wzorzec 2: window.ytInitialPlayerResponse = {...};
        if (!match) {
          match = content.match(/window\.ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
        }
        
        // Wzorzec 3: ytInitialPlayerResponse = {...}; (bez var/window)
        if (!match) {
          match = content.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
        }
        
        if (match && match[1]) {
          try {
            ytInitialPlayerResponse = JSON.parse(match[1]);
            console.log('[YouTube Content Script] ✓ Znaleziono ytInitialPlayerResponse w <script> tagu');
            break;
          } catch (e) {
            console.warn('[YouTube Content Script] ⚠️ Nie udało się sparsować:', e);
            continue;
          }
        }
      }
    }
    
    if (!ytInitialPlayerResponse) {
      console.error('[YouTube Content Script] ❌ Nie znaleziono ytInitialPlayerResponse');
      window._ytTranscriptData = { videoId, captionTracks: null, error: 'No ytInitialPlayerResponse' };
      return;
    }
    
    // Wyciągnij caption tracks
    const captions = ytInitialPlayerResponse.captions;
    if (!captions) {
      console.error('[YouTube Content Script] ❌ Brak sekcji captions');
      window._ytTranscriptData = { videoId, captionTracks: null, error: 'No captions section' };
      return;
    }
    
    const captionTracks = captions.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
      console.log('[YouTube Content Script] ⚠️ Brak dostępnych napisów dla tego filmu');
      window._ytTranscriptData = { videoId, captionTracks: null, error: 'No caption tracks available' };
      return;
    }
    
    console.log(`[YouTube Content Script] ✓ Znaleziono ${captionTracks.length} dostępnych transkrypcji`);
    captionTracks.forEach((track, i) => {
      console.log(`  [${i}] ${track.name?.simpleText || track.languageCode} (${track.languageCode})`);
    });
    
    // Zapisz dane
    window._ytTranscriptData = {
      videoId,
      captionTracks,
      timestamp: Date.now()
    };
    
    // Zapisz też język pierwszej transkrypcji (backward compatibility)
    window._ytTranscriptLang = captionTracks[0]?.languageCode || 'unknown';
    
    console.log('[YouTube Content Script] ✅ Dane transkrypcji zapisane w window._ytTranscriptData');
    
  } catch (error) {
    console.error('[YouTube Content Script] ❌ Błąd podczas przechwytywania:', error);
    window._ytTranscriptData = { error: error.message };
  }
}

// === 2. EXTRACT VIDEO ID ===
function extractVideoId(url) {
  try {
    const urlObj = new URL(url);
    
    // Format: youtube.com/watch?v=VIDEO_ID
    if (urlObj.hostname.includes('youtube.com')) {
      const videoId = urlObj.searchParams.get('v');
      if (videoId) return videoId;
    }
    
    // Format: youtu.be/VIDEO_ID
    if (urlObj.hostname.includes('youtu.be')) {
      const videoId = urlObj.pathname.slice(1);
      if (videoId) return videoId;
    }
    
    return null;
  } catch (e) {
    console.error('[YouTube Content Script] Błąd parsowania URL:', e);
    return null;
  }
}

// === 3. FETCH TRANSCRIPT ON DEMAND ===
async function fetchTranscript() {
  console.log('[YouTube Content Script] fetchTranscript() called');
  
  const data = window._ytTranscriptData;
  
  if (!data) {
    console.error('[YouTube Content Script] ❌ Brak _ytTranscriptData');
    return { transcript: '', error: 'No transcript data captured', method: 'none' };
  }
  
  if (data.error) {
    console.error('[YouTube Content Script] ❌ Błąd w captured data:', data.error);
    return { transcript: '', error: data.error, method: 'none' };
  }
  
  if (!data.captionTracks || data.captionTracks.length === 0) {
    console.error('[YouTube Content Script] ❌ Brak caption tracks');
    return { transcript: '', error: 'No caption tracks available', method: 'none' };
  }
  
  // Wybierz pierwszą dostępną transkrypcję
  const track = data.captionTracks[0];
  const langCode = track.languageCode || 'unknown';
  const langName = track.name?.simpleText || langCode;
  const baseUrl = track.baseUrl;
  
  if (!baseUrl) {
    console.error('[YouTube Content Script] ❌ Brak baseUrl');
    return { transcript: '', error: 'No baseUrl in caption track', method: 'none' };
  }
  
  console.log(`[YouTube Content Script] Pobieram transkrypcję: ${langName} (${langCode})`);
  console.log(`[YouTube Content Script] URL: ${baseUrl.substring(0, 100)}...`);
  
  try {
    // Spróbuj różnych formatów
    const formats = ['&fmt=srv3', '&fmt=json3', ''];
    let transcriptText = '';
    let successFormat = null;
    
    for (const fmt of formats) {
      try {
        const url = baseUrl + fmt;
        console.log(`[YouTube Content Script] Próbuję format: ${fmt || 'default'}`);
        
        const response = await fetch(url, { 
          method: 'GET',
          headers: { 'Accept': '*/*' }
        });
        
        if (!response.ok) {
          console.warn(`[YouTube Content Script] HTTP ${response.status} dla ${fmt}`);
          continue;
        }
        
        const text = await response.text();
        
        if (!text || text.length < 10) {
          console.warn(`[YouTube Content Script] Pusta odpowiedź dla ${fmt}`);
          continue;
        }
        
        console.log(`[YouTube Content Script] ✓ Pobrano ${text.length} znaków (${fmt})`);
        
        // Parsuj XML
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');
        const textElements = doc.querySelectorAll('text');
        
        if (textElements.length === 0) {
          console.warn(`[YouTube Content Script] Brak elementów <text> w XML dla ${fmt}`);
          continue;
        }
        
        // Wyciągnij tekst
        const texts = Array.from(textElements).map(element => {
          const content = element.textContent || '';
          // Dekoduj HTML entities
          const textarea = document.createElement('textarea');
          textarea.innerHTML = content;
          return textarea.value.trim();
        }).filter(t => t.length > 0);
        
        transcriptText = texts.join(' ');
        successFormat = fmt || 'default';
        
        console.log(`[YouTube Content Script] ✅ Sparsowano: ${textElements.length} segmentów → ${transcriptText.length} znaków`);
        break;
        
      } catch (formatError) {
        console.warn(`[YouTube Content Script] Błąd dla formatu ${fmt}:`, formatError);
        continue;
      }
    }
    
    if (!transcriptText) {
      throw new Error('Wszystkie formaty zawiodły');
    }
    
    return {
      transcript: transcriptText,
      lang: langCode,
      langName: langName,
      method: 'direct',
      format: successFormat
    };
    
  } catch (error) {
    console.error('[YouTube Content Script] ❌ Błąd pobierania:', error);
    return {
      transcript: '',
      error: error.message,
      method: 'direct-failed'
    };
  }
}

// === 4. FALLBACK API ===
async function fetchTranscriptViaAPI(videoId) {
  console.log(`[YouTube Content Script] Próbuję fallback API dla videoId: ${videoId}`);
  
  try {
    const apiUrl = `https://transcript.andreszenteno.com/simple-transcript?videoId=${videoId}`;
    console.log(`[YouTube Content Script] API URL: ${apiUrl}`);
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`API HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.transcript) {
      throw new Error('API nie zwróciło transkrypcji');
    }
    
    console.log(`[YouTube Content Script] ✅ API zwróciło ${data.transcript.length} znaków`);
    
    return {
      transcript: data.transcript,
      lang: data.language || 'unknown',
      method: 'api',
      title: data.title
    };
    
  } catch (error) {
    console.error('[YouTube Content Script] ❌ Błąd API:', error);
    return {
      transcript: '',
      error: error.message,
      method: 'api-failed'
    };
  }
}

// === 5. MESSAGE HANDLER ===
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[YouTube Content Script] Otrzymano message:', request.type);
  
  if (request.type === 'GET_TRANSCRIPT') {
    // Async handler
    (async () => {
      try {
        // 1. Spróbuj direct method
        console.log('[YouTube Content Script] Próbuję direct method...');
        let result = await fetchTranscript();
        
        // 2. Jeśli direct method zawiódł i mamy videoId, spróbuj API
        if (!result.transcript && window._ytTranscriptData?.videoId) {
          console.log('[YouTube Content Script] Direct method failed, próbuję API fallback...');
          const apiResult = await fetchTranscriptViaAPI(window._ytTranscriptData.videoId);
          
          // Użyj API result jeśli udało się
          if (apiResult.transcript) {
            result = apiResult;
          }
        }
        
        console.log(`[YouTube Content Script] Zwracam: ${result.transcript?.length || 0} znaków, metoda: ${result.method}`);
        if (!result.title) {
          result.title = document.title || '';
        }
        sendResponse(result);
        
      } catch (error) {
        console.error('[YouTube Content Script] ❌ Błąd w message handler:', error);
        sendResponse({
          transcript: '',
          error: error.message,
          method: 'error'
        });
      }
    })();
    
    return true; // Keep message channel open for async response
  }
  
  if (request.type === 'CHECK_TRANSCRIPT_DATA') {
    // Debug endpoint - sprawdź czy dane są dostępne
    sendResponse({
      hasData: !!window._ytTranscriptData,
      videoId: window._ytTranscriptData?.videoId,
      hasCaptionTracks: !!(window._ytTranscriptData?.captionTracks?.length > 0),
      error: window._ytTranscriptData?.error,
      timestamp: window._ytTranscriptData?.timestamp
    });
    return true;
  }
});

// === 6. INITIAL CAPTURE ===
// Uruchom capture gdy DOM jest gotowy
function initCapture() {
  console.log('[YouTube Content Script] initCapture(), readyState:', document.readyState);
  
  // Sprawdź czy jesteśmy na stronie video
  if (!window.location.pathname.includes('/watch')) {
    console.log('[YouTube Content Script] Nie jesteśmy na stronie /watch, pomijam');
    return;
  }
  
  // Opóźnienie aby dać YouTube czas na załadowanie skryptów
  setTimeout(() => {
    captureYouTubeData();
  }, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCapture);
} else {
  initCapture();
}

// === 7. SPA NAVIGATION ===
// YouTube używa SPA - strona nie przeładowuje się przy zmianie video
// Nasłuchuj na YouTube navigation events

// Metoda 1: yt-navigate-finish (custom YouTube event)
window.addEventListener('yt-navigate-finish', () => {
  console.log('[YouTube Content Script] yt-navigate-finish event');
  setTimeout(() => {
    captureYouTubeData();
  }, 500);
});

// Metoda 2: popstate (browser history)
window.addEventListener('popstate', () => {
  console.log('[YouTube Content Script] popstate event');
  if (window.location.pathname.includes('/watch')) {
    setTimeout(() => {
      captureYouTubeData();
    }, 500);
  }
});

// Metoda 3: Obserwuj zmiany URL przez setInterval (fallback)
let lastUrl = window.location.href;
setInterval(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    console.log('[YouTube Content Script] URL zmieniony:', currentUrl);
    lastUrl = currentUrl;
    
    if (window.location.pathname.includes('/watch')) {
      setTimeout(() => {
        captureYouTubeData();
      }, 500);
    }
  }
}, 1000);

console.log('[YouTube Content Script] Setup complete - nasłuchuję na video load i nawigację');


