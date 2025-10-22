// article-selector.js - okno wyboru artykułów do analizy portfela

const articlesList = document.getElementById('articlesList');
const selectionInfo = document.getElementById('selectionInfo');
const submitBtn = document.getElementById('submitBtn');
const cancelBtn = document.getElementById('cancelBtn');
const selectAllBtn = document.getElementById('selectAllBtn');

let articles = [];
let selectedArticleIds = new Set();

// Pobierz dane artykułów z URL parameters
const urlParams = new URLSearchParams(window.location.search);
const articlesData = urlParams.get('articles');

if (articlesData) {
  try {
    articles = JSON.parse(decodeURIComponent(articlesData));
    renderArticles();
  } catch (error) {
    console.error('Błąd parsowania danych artykułów:', error);
  }
}

// Renderuj listę artykułów
function renderArticles() {
  articlesList.innerHTML = '';
  
  if (articles.length === 0) {
    articlesList.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">Brak artykułów do wyświetlenia</div>';
    return;
  }
  
  articles.forEach((article, index) => {
    const item = document.createElement('div');
    item.className = 'article-item';
    if (selectedArticleIds.has(index)) {
      item.classList.add('selected');
    }
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'article-checkbox';
    checkbox.checked = selectedArticleIds.has(index);
    checkbox.id = `article-${index}`;
    
    const content = document.createElement('div');
    content.className = 'article-content';
    
    const title = document.createElement('div');
    title.className = 'article-title';
    title.textContent = article.title || 'Bez tytułu';
    
    const url = document.createElement('div');
    url.className = 'article-url';
    url.textContent = article.url;
    
    content.appendChild(title);
    content.appendChild(url);
    
    item.appendChild(checkbox);
    item.appendChild(content);
    
    // Toggle selection on click
    item.addEventListener('click', () => {
      toggleArticle(index);
    });
    
    articlesList.appendChild(item);
  });
  
  updateSelectionInfo();
}

// Toggle zaznaczenia artykułu
function toggleArticle(index) {
  if (selectedArticleIds.has(index)) {
    selectedArticleIds.delete(index);
  } else {
    selectedArticleIds.add(index);
  }
  renderArticles();
}

// Aktualizuj info o zaznaczeniu
function updateSelectionInfo() {
  const count = selectedArticleIds.size;
  
  if (count === 0) {
    selectionInfo.textContent = 'Nie zaznaczono artykułów';
  } else if (count === 1) {
    selectionInfo.textContent = 'Zaznaczono 1 artykuł';
  } else {
    selectionInfo.textContent = `Zaznaczono ${count} artykułów`;
  }
}

// Obsługa przycisku "Zaznacz wszystkie"
selectAllBtn.addEventListener('click', () => {
  if (selectedArticleIds.size === articles.length) {
    // Jeśli wszystkie zaznaczone - odznacz wszystkie
    selectedArticleIds.clear();
    selectAllBtn.textContent = 'Zaznacz wszystkie';
  } else {
    // Zaznacz wszystkie
    selectedArticleIds = new Set(articles.map((_, index) => index));
    selectAllBtn.textContent = 'Odznacz wszystkie';
  }
  renderArticles();
});

// Aktualizuj tekst przycisku w zależności od stanu
function updateSelectAllButton() {
  if (selectedArticleIds.size === articles.length && articles.length > 0) {
    selectAllBtn.textContent = 'Odznacz wszystkie';
  } else {
    selectAllBtn.textContent = 'Zaznacz wszystkie';
  }
}

// Obserwuj zmiany w selectedArticleIds
const originalRender = renderArticles;
renderArticles = function() {
  originalRender();
  updateSelectAllButton();
};

// Obsługa przycisku Submit
submitBtn.addEventListener('click', () => {
  const selectedArticles = Array.from(selectedArticleIds).map(index => articles[index]);
  
  chrome.runtime.sendMessage({
    type: 'ARTICLE_SELECTION_SUBMIT',
    selectedArticles: selectedArticles,
    selectedIndices: Array.from(selectedArticleIds)
  });
});

// Obsługa przycisku Cancel
cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'ARTICLE_SELECTION_CANCEL'
  });
});

