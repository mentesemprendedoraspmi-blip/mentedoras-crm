// Lee el calendario de Google (URL secreta guardada como variable de entorno,
// nunca expuesta al navegador) y devuelve solo los eventos de grabacion que
// coinciden con clientes reales del CRM. No expone titulos de eventos personales.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const icalUrl = process.env.CALENDAR_ICAL_URL;
  if (!icalUrl) {
    res.status(500).json({ error: 'CALENDAR_ICAL_URL no configurada' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body);
  } catch (e) {
    body = null;
  }
  const names = Array.isArray(body?.names) ? body.names : null;
  const owners = Array.isArray(body?.owners) ? body.owners : [];
  const mode = body?.mode === 'calendar' ? 'calendar' : 'grabado';
  if (!names || !names.length) {
    res.status(400).json({ error: 'Falta la lista de nombres de clientes' });
    return;
  }

  let icsText;
  try {
    const r = await fetch(icalUrl);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    icsText = await r.text();
  } catch (e) {
    res.status(502).json({ error: 'No se pudo leer el calendario: ' + e.message });
    return;
  }

  const events = parseIcs(icsText);

  // modo "grabado" (deteccion automatica): solo ultimos 10 dias, requiere "grab" en el titulo.
  // modo "calendar" (vista de calendario): rango explicito from/to, cualquier evento que coincida con un cliente.
  const now = Date.now();
  let from, to;
  if (mode === 'calendar') {
    from = body?.from ? new Date(body.from).getTime() : now - 30 * 24 * 60 * 60 * 1000;
    to = body?.to ? new Date(body.to).getTime() : now + 60 * 24 * 60 * 60 * 1000;
  } else {
    from = now - 10 * 24 * 60 * 60 * 1000;
    to = now;
  }
  const inRange = events.filter(e => e.date && e.date.getTime() >= from && e.date.getTime() <= to);

  // Quita acentos/diacriticos para comparar sin distinguir "grabacion" de "grabación"
  const DIACRITICS = /[̀-ͯ]/g;
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(DIACRITICS, '').trim();
  const recKeyword = /grab/i; // "grabar" / "grabacion" / "GRABACION" etc.

  // Pares [nombreDevuelto, textoABuscar] — cada cliente aporta su nombre de negocio y, si lo tiene, el del dueño.
  const candidates = names.map((n, idx) => ({ client: n, needle: norm(n) }))
    .concat(owners.map((o, idx) => ({ client: names[idx], needle: norm(o) })).filter(c => c.needle));

  const matches = [];
  inRange.forEach(e => {
    if (mode === 'grabado' && !recKeyword.test(e.title)) return;
    const t = norm(e.title);
    for (const cand of candidates) {
      if (cand.needle.length < 3) continue;
      if (t.includes(cand.needle)) {
        matches.push({ client: cand.client, title: e.title, date: e.date.toISOString() });
        break;
      }
    }
  });

  res.status(200).json({ matches });
}

// Parser minimo de iCal: desdobla lineas (RFC5545) y extrae SUMMARY + DTSTART de cada VEVENT.
function parseIcs(text) {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
    } else if (line === 'END:VEVENT') {
      if (cur && cur.title && cur.date) events.push(cur);
      cur = null;
    } else if (cur) {
      if (line.startsWith('SUMMARY:')) {
        cur.title = line.slice('SUMMARY:'.length);
      } else if (line.startsWith('DTSTART')) {
        const val = line.split(':').slice(1).join(':');
        cur.date = parseIcsDate(val);
      }
    }
  }
  return events;
}

function parseIcsDate(val) {
  // Formatos: 20260724T080000Z | 20260724T080000 | 20260724 (todo el dia)
  const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (h === undefined) {
    return new Date(Date.UTC(+y, +mo - 1, +d));
  }
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}
