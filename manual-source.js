// manual-source.js - logika okna ręcznego wklejania źródła

const titleInput = document.getElementById('titleInput');
const sourceInput = document.getElementById('sourceInput');
const instancesValue = document.getElementById('instancesValue');
const decreaseBtn = document.getElementById('decreaseBtn');
const increaseBtn = document.getElementById('increaseBtn');
const submitBtn = document.getElementById('submitBtn');
const cancelBtn = document.getElementById('cancelBtn');

let instances = 1;

// Aktualizuj stan przycisku Submit
function updateSubmitButton() {
  const hasText = sourceInput.value.trim().length > 0;
  submitBtn.disabled = !hasText;
}

// Aktualizuj wyświetlanie liczby instancji
function updateInstancesDisplay() {
  instancesValue.textContent = instances;
  decreaseBtn.disabled = instances <= 1;
  increaseBtn.disabled = instances >= 10;
}

// Nasłuchuj zmian w textarea
sourceInput.addEventListener('input', updateSubmitButton);

// Obsługa przycisków +/-
decreaseBtn.addEventListener('click', () => {
  if (instances > 1) {
    instances--;
    updateInstancesDisplay();
  }
});

increaseBtn.addEventListener('click', () => {
  if (instances < 10) {
    instances++;
    updateInstancesDisplay();
  }
});

// Obsługa przycisku Submit
submitBtn.addEventListener('click', () => {
  const text = sourceInput.value.trim();
  const title = titleInput.value.trim() || 'Ręcznie wklejony artykuł';
  
  if (text.length > 0) {
    // Wyłącz przycisk i pokaż feedback
    submitBtn.disabled = true;
    submitBtn.textContent = 'Uruchamiam...';
    
    console.log('Wysyłam MANUAL_SOURCE_SUBMIT:', { text: text.substring(0, 100), title, instances });
    
    chrome.runtime.sendMessage({
      type: 'MANUAL_SOURCE_SUBMIT',
      text: text,
      title: title,
      instances: instances
    }, (response) => {
      console.log('Message wysłany, odpowiedź:', response);
      
      if (response && response.success) {
        submitBtn.textContent = '✓ Uruchomiono';
        // Zamknij okno po krótkiej przerwie
        setTimeout(() => window.close(), 500);
      } else {
        submitBtn.textContent = '✗ Błąd';
        submitBtn.disabled = false;
        setTimeout(() => {
          submitBtn.textContent = 'Uruchom';
        }, 2000);
      }
    });
  }
});

// Obsługa przycisku Cancel
cancelBtn.addEventListener('click', () => {
  window.close();
});

// Obsługa Enter z Ctrl/Cmd
sourceInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!submitBtn.disabled) {
      submitBtn.click();
    }
  }
});

// Inicjalizacja
updateSubmitButton();
updateInstancesDisplay();

