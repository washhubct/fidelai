// FidelAI — Navigation Module
import state from '../state.js';

const modules = {
    home: { title: 'Dashboard', icon: '🏠' },
    loyalty: { title: 'Loyalty Engine', icon: '⭐' },
    clienti: { title: 'Clienti / CRM', icon: '👥' },
    campagne: { title: 'Campagne', icon: '📣' },
    analytics: { title: 'Analytics', icon: '📊' },
    'ai-agent': { title: 'AI Agent', icon: '🤖' },
    impostazioni: { title: 'Impostazioni', icon: '⚙️' }
};

export function initNavigazione() {
    document.querySelectorAll('.nav-item[data-module]').forEach(item => {
        item.addEventListener('click', () => {
            navigateTo(item.dataset.module);
        });
    });

    // Mobile menu toggle
    const menuToggle = document.getElementById('menu-toggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', () => {
            document.querySelector('.sidebar').classList.toggle('open');
        });
    }
}

export function navigateTo(moduleId) {
    state.currentModule = moduleId;

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.module === moduleId);
    });

    // Update sections
    document.querySelectorAll('.module-section').forEach(section => {
        section.classList.toggle('active', section.id === `module-${moduleId}`);
    });

    // Update topbar title
    const topTitle = document.getElementById('top-title');
    if (topTitle && modules[moduleId]) {
        topTitle.textContent = modules[moduleId].title;
    }

    // Transazione solo in home; il riscatto serve anche dall'elenco clienti
    const transBtn = document.getElementById('btn-add-transaction');
    if (transBtn) transBtn.style.display = moduleId === 'home' ? '' : 'none';
    const redeemBtn = document.getElementById('btn-redeem');
    if (redeemBtn) redeemBtn.style.display = ['home', 'clienti'].includes(moduleId) ? '' : 'none';

    // Close mobile sidebar
    document.querySelector('.sidebar')?.classList.remove('open');

    // Dispatch event for module init
    window.dispatchEvent(new CustomEvent('module-change', { detail: { module: moduleId } }));
}
