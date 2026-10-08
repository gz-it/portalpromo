(function () {
  const moduleBar = document.querySelector('.event-workspace .module-bar');
  const activeModule = moduleBar?.querySelector('[aria-current="page"]');
  if (activeModule) {
    if (window.matchMedia('(max-width: 960px)').matches) {
      moduleBar.scrollLeft = activeModule.offsetLeft - moduleBar.offsetLeft;
    } else {
      const centerTop = Math.max(0, activeModule.offsetTop - (moduleBar.clientHeight - activeModule.offsetHeight) / 2);
      const firstVisible = Array.from(moduleBar.children).reverse().find(item => item.offsetTop <= centerTop);
      moduleBar.scrollTop = firstVisible?.offsetTop || 0;
    }
  }
  let dirty = false;
  document.querySelectorAll('input, textarea, select').forEach((el) => {
    el.addEventListener('change', () => { dirty = true; });
  });
  document.querySelectorAll('form').forEach((form) => {
    form.addEventListener('submit', () => { dirty = false; });
  });
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  document.querySelectorAll('.upload-form').forEach((form) => {
    form.addEventListener('submit', (event) => {
      const file = form.querySelector('input[type="file"]');
      const progress = form.querySelector('progress');
      if (!file || !file.files.length || !progress || !window.XMLHttpRequest) return;
      event.preventDefault();
      dirty = false;
      progress.hidden = false;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', form.action);
      xhr.setRequestHeader('X-CSRF-Token', window.csrfToken || '');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) progress.value = Math.round((e.loaded / e.total) * 100);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 400) window.location.reload();
        else alert('No se pudo subir el archivo. Reintente.');
      });
      xhr.addEventListener('error', () => alert('No se pudo subir el archivo. Reintente.'));
      xhr.send(new FormData(form));
    });
  });

  document.querySelectorAll('.sector-form').forEach((form) => {
    const rows = form.querySelector('.sector-rows');
    const template = form.querySelector('.sector-template');
    form.querySelector('.add-sector')?.addEventListener('click', () => {
      rows.appendChild(template.content.cloneNode(true));
      dirty = true;
    });
    form.addEventListener('click', (event) => {
      const remove = event.target.closest('.remove-sector');
      if (!remove) return;
      const row = remove.closest('.sector-row');
      if (rows.children.length === 1) {
        row.querySelectorAll('input').forEach((input) => { input.value = ''; });
      } else row.remove();
      dirty = true;
    });
  });
}());
