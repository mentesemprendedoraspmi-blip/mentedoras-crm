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

  let names;
  try {
    names = Array.isArray(req.body?.names) ? req.body.names : JSON.parse(req.body).names;
  } catch (e) {
    names = null;
  }
  if (!Array.isArray(names) || !names.length) {
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

  // Solo eventos de los ultimos 10 dias hasta hoy (no futuros, no muy antiguos)
  const now = Date.now();
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
  const recent = events.filter(e => {
    if (!e.date) return false;
    const t = e.date.getTime();
    return t <= now && (now - t) <= tenDaysMs;
  });

  // Quita acentos/diacriticos para comparar sin distinguir "grabacion" de "grabación"
  const DIACRITICS = /[̀-ͯ]/g;
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(DIACRITICS, '').trim();
  const recKeyword = /grab/i; // "grabar" / "grabacion" / "GRABACION" etc.

  const matches = [];
  recent.forEach(e => {
    if (!recKeyword.test(e.title)) return;
    const t = norm(e.title);
    for (const name of names) {
      const n = norm(name);
      if (n.length < 3) continue;
      if (t.includes(n)) {
        matches.push({ client: name, title: e.title, date: e.date.toISOString() });
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
