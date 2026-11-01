'use client';

import { useState } from 'react';
import { fitView, MAP_VIEWBOX, project } from '@/lib/map-projection';

const input = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900';

/**
 * The map pin (portal spec §6.1) without a map service (plan P3, decision 15):
 * latitude and longitude, or this device's location. It is stored exactly and
 * only ever shown publicly rounded to about a kilometre.
 */
export function PinInput() {
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [message, setMessage] = useState('');

  function useDevice() {
    if (!navigator.geolocation) return setMessage('This browser cannot tell its location. Type the position instead.');
    setMessage('Asking this device…');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(6));
        setLon(p.coords.longitude.toFixed(6));
        setMessage('Filled in from this device. Check it is the site, not where you are now.');
      },
      () => setMessage('The location was not available. Type the position instead.'),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  const la = Number(lat);
  const lo = Number(lon);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Where the antenna is</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Latitude</span>
          <input name="lat" value={lat} onChange={(e) => setLat(e.target.value)} required inputMode="decimal" placeholder="39.414371" className={input} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Longitude</span>
          <input name="lon" value={lon} onChange={(e) => setLon(e.target.value)} required inputMode="decimal" placeholder="-77.410541" className={input} />
        </label>
      </div>
      <button type="button" onClick={useDevice} className="rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
        Use this device&apos;s location
      </button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <p className="text-sm text-slate-500">The public map shows it rounded to about a kilometre. Only you and the admins see the exact position.</p>
      {lat !== '' && lon !== '' && la >= 14 && la <= 72 && lo >= -180 && lo <= -50 && <PinPreview lat={la} lon={lo} />}
    </fieldset>
  );
}

/** Where that is, on the bundled basemap: no map service, nothing leaves this page. */
function PinPreview({ lat, lon }: { lat: number; lon: number }) {
  const [x, y, w, h] = fitView([{ lat, lon }]);
  const [cx, cy] = project(lat, lon);
  const [mx, my, mw, mh] = MAP_VIEWBOX;
  return (
    <svg role="img" aria-label="Preview of the position" viewBox={`${x} ${y} ${w} ${h}`} className="max-h-64 w-full rounded border border-slate-200 bg-sky-50 dark:border-slate-800 dark:bg-slate-900">
      <image href="/coverage/basemap.svg" x={mx} y={my} width={mw} height={mh} />
      <circle cx={cx} cy={cy} r={Math.max(w, h) / 60} className="fill-red-600 stroke-white" />
    </svg>
  );
}
