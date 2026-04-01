// Expandable info-explanation toggles
// Wires up all .info-toggle buttons to show/hide their paired .info-expand panels

export function initExplainers() {
    const toggles = document.querySelectorAll('.info-toggle');
    for (const btn of toggles) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = btn.getAttribute('data-info');
            const panel = document.getElementById(`info-${key}`);
            if (!panel) return;

            const isOpen = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', String(!isOpen));

            if (isOpen) {
                panel.style.maxHeight = '0';
                panel.addEventListener('transitionend', () => {
                    if (btn.getAttribute('aria-expanded') === 'false') {
                        panel.hidden = true;
                    }
                }, { once: true });
            } else {
                panel.hidden = false;
                // Force reflow so transition fires
                panel.offsetHeight;
                panel.style.maxHeight = panel.scrollHeight + 'px';
            }
        });
    }
}
