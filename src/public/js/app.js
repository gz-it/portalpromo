(function () {
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
}());
