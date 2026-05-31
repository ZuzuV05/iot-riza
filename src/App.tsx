import React, { useState, useEffect, useCallback, useRef } from 'react';
import mqtt from 'mqtt';
import { Power, Settings2, Droplets, Thermometer, Wifi, WifiOff, Zap, Lightbulb, Activity, RotateCw, Mic, MicOff, Send, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { SensorData, RelayStatus } from './types';

const BROKER_URL   = 'wss://broker.emqx.io:8084/mqtt';
const BOT_TOKEN    = '8701088647:AAEzFYbNP7mM2ESLdtLPZPMAvhLr0NC7DvU';
const CHAT_ID      = '1250404612';

// ─── Telegram Helper ───────────────────────────────────────────
async function sendTelegramNotification(message: string) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.warn('Telegram notif failed:', e);
  }
}

// ─── Voice Recognition ─────────────────────────────────────────
type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
  start(): void;
  stop(): void;
};

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

function parseVoiceCommand(text: string): { cmd: string; label: string } | null {
  const t = text.toLowerCase().trim();

  // Angka kata → digit
  const wordToNum: Record<string, string> = {
    'satu': '1', 'dua': '2', 'tiga': '3', 'empat': '4',
    'pertama': '1', 'kedua': '2', 'ketiga': '3', 'keempat': '4',
  };
  const normalize = (s: string) =>
    s.replace(/\b(satu|dua|tiga|empat|pertama|kedua|ketiga|keempat)\b/g, m => wordToNum[m]);
  const tn = normalize(t);

  // Individual relay — cek dulu sebelum "semua"
  for (const num of ['1', '2', '3', '4']) {
    const onPattern  = new RegExp(`(nyalakan|hidupkan|aktifkan)\\s*(lampu|relay)\\s*${num}|lampu\\s*${num}\\s*(nyala|on)`);
    const offPattern = new RegExp(`(matikan|padamkan|nonaktifkan)\\s*(lampu|relay)\\s*${num}|lampu\\s*${num}\\s*(mati|off)`);
    if (onPattern.test(tn))  return { cmd: `r${num}_on`,  label: `Nyalakan Lampu ${num}` };
    if (offPattern.test(tn)) return { cmd: `r${num}_off`, label: `Matikan Lampu ${num}` };
  }

  if (t.includes('nyalakan lampu') || t.includes('hidupkan lampu') || t.includes('lampu nyala') || t.includes('semua nyala'))
    return { cmd: 'all_on', label: 'Nyalakan Semua Lampu' };
  if (t.includes('matikan lampu') || t.includes('lampu mati') || t.includes('semua mati') || t.includes('padamkan lampu'))
    return { cmd: 'all_off', label: 'Matikan Semua Lampu' };
  if (t.includes('variasi 1') || t.includes('variasi satu') || t.includes('disco'))
    return { cmd: 'v1_on', label: 'Nyalakan Variasi 1 (Disco)' };
  if (t.includes('variasi 2') || t.includes('variasi dua') || t.includes('bertahap'))
    return { cmd: 'v2_on', label: 'Nyalakan Variasi 2 (Bertahap)' };
  if (t.includes('stop variasi') || t.includes('hentikan variasi') || t.includes('stop pola'))
    return { cmd: 'v_stop', label: 'Stop Variasi' };
  if (t.includes('suhu') || t.includes('temperatur') || t.includes('panas'))
    return { cmd: 'get_sensor', label: 'Cek Suhu & Kelembapan' };
  if (t.includes('kelembapan') || t.includes('kelembaban') || t.includes('lembab'))
    return { cmd: 'get_sensor', label: 'Cek Kelembapan' };
  return null;
}

// ─── Notification type ─────────────────────────────────────────
type Notif = { id: string; type: 'success' | 'error' | 'info'; title: string; body: string };

export default function App() {
  const [deviceId, setDeviceId]       = useState('XX');
  const [connected, setConnected]     = useState(false);
  const [client, setClient]           = useState<mqtt.MqttClient | null>(null);

  const [sensorData, setSensorData]   = useState<SensorData>({ suhu: 0, kelembaban: 0 });
  const [relayStatus, setRelayStatus] = useState<RelayStatus>({ r1: 0, r2: 0, r3: 0, r4: 0, v1: 0, v2: 0 });
  const [logs, setLogs]               = useState<{ id: string; text: string }[]>([]);
  const [notifs, setNotifs]           = useState<Notif[]>([]);

  // Voice
  const [voiceActive, setVoiceActive]     = useState(false);
  const [transcript, setTranscript]       = useState('');
  const [voiceResult, setVoiceResult]     = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const voiceSupportRef = useRef(typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition));

  // Device status flags
  const prevRelayRef = useRef<RelayStatus | null>(null);

  const addLog = useCallback((text: string) => {
    setLogs(prev => {
      const item = { id: Math.random().toString(36).substr(2, 9), text };
      return [item, ...prev].slice(0, 10);
    });
  }, []);

  const pushNotif = useCallback((type: Notif['type'], title: string, body: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    setNotifs(prev => [{ id, type, title, body }, ...prev].slice(0, 5));
    setTimeout(() => setNotifs(prev => prev.filter(n => n.id !== id)), 4000);
  }, []);

  // ── MQTT Connection ─────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;
    const mqttClient = mqtt.connect(BROKER_URL, {
      clientId: `web_${Math.random().toString(16).substring(2, 10)}`,
      keepalive: 60,
      clean: true,
      protocolVersion: 4,
      reconnectPeriod: 3000,
    });

    mqttClient.on('connect', () => {
      if (!isMounted) return;
      setConnected(true);
      addLog('Terhubung ke MQTT broker');
      setClient(mqttClient);
    });
    mqttClient.on('close',  () => { if (isMounted) setConnected(false); });
    mqttClient.on('error',  (err) => {
      if (isMounted) {
        setConnected(false);
        if (!err.message?.includes('disconnecting')) console.warn('MQTT:', err.message);
      }
    });

    return () => { isMounted = false; mqttClient.end(true); };
  }, [addLog]);

  // ── Topic Subscription ──────────────────────────────────────
  useEffect(() => {
    if (!client || !connected || !deviceId.trim()) return;
    const id = deviceId.trim();
    const statusTopic = `smartlight/${id}/status`;
    const sensorTopic = `smartlight/${id}/sensor`;
    const cmdTopic    = `smartlight/${id}/cmd`;

    client.subscribe(statusTopic, { qos: 0 });
    client.subscribe(sensorTopic, { qos: 0 });
    addLog(`Memantau perangkat: ${id}`);

    const handleMessage = (topic: string, message: Buffer) => {
      try {
        const raw = message.toString().replace(/,\s*}/g, '}');
        if (topic === statusTopic) {
          const parsed: RelayStatus = JSON.parse(raw);
          setRelayStatus(prev => {
            // ── Telegram notif on relay change ──────────────
            if (prevRelayRef.current) {
              const prev2 = prevRelayRef.current;
              const lines: string[] = [];
              for (let i = 1; i <= 4; i++) {
                const k = `r${i}` as keyof RelayStatus;
                if (prev2[k] !== parsed[k]) {
                  lines.push(`💡 <b>Lampu ${i}</b>: ${parsed[k] === 1 ? '🟢 ON' : '🔴 OFF'}`);
                }
              }
              if (prev2.v1 !== parsed.v1) lines.push(`✨ <b>Variasi 1</b>: ${parsed.v1 === 1 ? '🟢 Aktif' : '🔴 Berhenti'}`);
              if (prev2.v2 !== parsed.v2) lines.push(`✨ <b>Variasi 2</b>: ${parsed.v2 === 1 ? '🟢 Aktif' : '🔴 Berhenti'}`);
              if (lines.length > 0) {
                const msg = `🏠 <b>Notifikasi SmartLight</b>\nDevice: <code>${id}</code>\n\n${lines.join('\n')}`;
                sendTelegramNotification(msg);
                const summary = lines.map(l => l.replace(/<[^>]+>/g, '')).join(', ');
                pushNotif('success', 'Notifikasi Terkirim', summary);
              }
            }
            prevRelayRef.current = parsed;
            return parsed;
          });
          addLog('> Status disinkronkan');
        } else if (topic === sensorTopic) {
          setSensorData(JSON.parse(raw));
        }
      } catch (err) {
        console.error('Parse error:', message.toString());
      }
    };

    client.on('message', handleMessage);
    client.publish(cmdTopic, 'get_status', { qos: 0 });
    client.publish(cmdTopic, 'get_sensor', { qos: 0 });

    return () => {
      client.off('message', handleMessage);
      client.unsubscribe(statusTopic);
      client.unsubscribe(sensorTopic);
    };
  }, [client, connected, deviceId, addLog, pushNotif]);

  // ── Send Command ────────────────────────────────────────────
  const sendCommand = useCallback((cmd: string, source: 'manual' | 'voice' = 'manual') => {
    const id = deviceId.trim();
    if (!client || !connected || !id) {
      addLog(!connected ? 'Err: Tidak terhubung' : 'Err: Device ID kosong');
      return;
    }
    const topic = `smartlight/${id}/cmd`;
    addLog(`${source === 'voice' ? '🎤' : '→'} ${cmd}`);
    client.publish(topic, cmd, { qos: 0, retain: false }, (err) => {
      if (err) addLog(`Err: ${err.message}`);
    });
  }, [client, connected, deviceId, addLog]);

  // ── Voice Recognition ───────────────────────────────────────
  const startVoice = useCallback(() => {
    if (!voiceSupportRef.current) {
      pushNotif('error', 'Tidak Didukung', 'Browser ini tidak mendukung Web Speech API');
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SR();
    recognition.lang = 'id-ID';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        interim += e.results[i][0].transcript;
      }
      setTranscript(interim);
      if (e.results[e.resultIndex]?.isFinal) {
        const final = e.results[e.resultIndex][0].transcript;
        const parsed = parseVoiceCommand(final);
        if (parsed) {
          setVoiceResult(`✓ "${parsed.label}"`);
          sendCommand(parsed.cmd, 'voice');
          // For sensor queries, show data in UI
          if (parsed.cmd === 'get_sensor') {
            pushNotif('info', 'Data Sensor', `Suhu: ${sensorData.suhu.toFixed(1)}°C · Kelembapan: ${sensorData.kelembaban.toFixed(1)}%`);
          }
        } else {
          setVoiceResult(`✗ Tidak dikenali: "${final}"`);
          pushNotif('error', 'Perintah Tidak Dikenali', `"${final}"`);
        }
      }
    };
    recognition.onend = () => {
      setVoiceActive(false);
      setTranscript('');
    };
    recognition.onerror = (e: any) => {
      setVoiceActive(false);
      setTranscript('');
      if (e.error !== 'aborted') pushNotif('error', 'Error Mikrofon', e.error);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setVoiceActive(true);
    setTranscript('');
    setVoiceResult(null);
  }, [sendCommand, pushNotif, sensorData]);

  const stopVoice = useCallback(() => {
    recognitionRef.current?.stop();
    setVoiceActive(false);
  }, []);

  // ── Relay card helpers ──────────────────────────────────────
  const totalOn = [relayStatus.r1, relayStatus.r2, relayStatus.r3, relayStatus.r4].filter(v => v === 1).length;
  const anyVariasi = relayStatus.v1 === 1 || relayStatus.v2 === 1;

  return (
    <div className="min-h-screen bg-[#070b14] text-white font-sans overflow-x-hidden relative">
      {/* Ambient BG */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-[-200px] left-[-200px] w-[600px] h-[600px] rounded-full bg-cyan-500/5 blur-3xl" />
        <div className="absolute bottom-[-200px] right-[-200px] w-[600px] h-[600px] rounded-full bg-violet-500/5 blur-3xl" />
      </div>

      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80">
        {notifs.map(n => (
          <div key={n.id}
            className={`flex items-start gap-3 p-3 rounded-xl border backdrop-blur-md text-sm shadow-lg
              ${n.type === 'success' ? 'bg-green-500/10 border-green-500/30 text-green-300' :
                n.type === 'error'   ? 'bg-red-500/10 border-red-500/30 text-red-300' :
                                       'bg-cyan-500/10 border-cyan-500/30 text-cyan-300'}`}>
            {n.type === 'success' ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" /> :
             n.type === 'error'   ? <XCircle className="w-4 h-4 mt-0.5 shrink-0" /> :
                                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
            <div>
              <div className="font-semibold text-xs uppercase tracking-wider">{n.title}</div>
              <div className="opacity-80 mt-0.5">{n.body}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-4 py-6 space-y-5">

        {/* ── HEADER ────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4
                        bg-white/3 border border-white/8 rounded-2xl px-6 py-4 backdrop-blur-sm">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center
              ${connected ? 'bg-cyan-500/15 ring-1 ring-cyan-500/40' : 'bg-red-500/15 ring-1 ring-red-500/30'}`}>
              {connected
                ? <Wifi className="w-6 h-6 text-cyan-400" />
                : <WifiOff className="w-6 h-6 text-red-400" />}
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                Smart<span className="text-cyan-400">Light</span> Dashboard
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400 shadow-[0_0_6px_#4ade80]' : 'bg-red-400'}`} />
                <span className="text-xs text-gray-500 font-mono tracking-wider uppercase">
                  {connected ? 'Broker Online' : 'Broker Offline'}
                </span>
              </div>
            </div>
          </div>

          {/* Device ID Input */}
          <div className="flex items-end gap-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1 flex items-center gap-1">
                <Settings2 className="w-3 h-3" /> Device ID
              </label>
              <input
                type="text"
                value={deviceId}
                onChange={e => setDeviceId(e.target.value.toUpperCase())}
                placeholder="XX"
                className="bg-white/5 border border-white/10 focus:border-cyan-400/60 rounded-xl
                           px-4 py-2.5 w-36 font-mono text-cyan-400 text-lg font-bold tracking-widest
                           uppercase outline-none transition-all placeholder:text-gray-700"
              />
            </div>
            <button
              onClick={() => { sendCommand('get_status'); sendCommand('get_sensor'); }}
              className="p-2.5 rounded-xl bg-white/5 hover:bg-cyan-500/10 border border-white/10
                         hover:border-cyan-500/30 text-gray-400 hover:text-cyan-400 transition-all"
              title="Sync ulang"
            >
              <RotateCw className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ── DEVICE STATUS SUMMARY ───────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* Lampu Aktif */}
          <div className="bg-white/3 border border-white/8 rounded-2xl px-4 py-4">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-2 flex items-center gap-1">
              <Lightbulb className="w-3 h-3" /> Lampu Aktif
            </div>
            <div className="text-3xl font-bold text-cyan-400">{totalOn}<span className="text-lg text-gray-600">/4</span></div>
            <div className="text-[10px] text-gray-600 mt-1 font-mono">
              {totalOn === 0 ? 'Semua mati' : totalOn === 4 ? 'Semua nyala' : `${totalOn} relay ON`}
            </div>
          </div>

          {/* Mode */}
          <div className="bg-white/3 border border-white/8 rounded-2xl px-4 py-4">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-2 flex items-center gap-1">
              <Zap className="w-3 h-3" /> Mode
            </div>
            <div className={`text-lg font-bold ${anyVariasi ? 'text-violet-400' : 'text-gray-500'}`}>
              {relayStatus.v1 === 1 ? 'Disco' : relayStatus.v2 === 1 ? 'Bertahap' : 'Manual'}
            </div>
            <div className="text-[10px] text-gray-600 mt-1 font-mono">
              {anyVariasi ? 'Pola aktif' : 'Kontrol manual'}
            </div>
          </div>

          {/* Suhu */}
          <div className="bg-white/3 border border-white/8 rounded-2xl px-4 py-4">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-2 flex items-center gap-1">
              <Thermometer className="w-3 h-3 text-orange-400" /> Suhu
            </div>
            <div className="text-3xl font-bold text-orange-400">{sensorData.suhu.toFixed(1)}<span className="text-base text-gray-600">°C</span></div>
            <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
              <div className="h-full bg-orange-400 rounded-full transition-all duration-1000"
                style={{ width: `${Math.min(100, (sensorData.suhu / 50) * 100)}%` }} />
            </div>
          </div>

          {/* Kelembapan */}
          <div className="bg-white/3 border border-white/8 rounded-2xl px-4 py-4">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-2 flex items-center gap-1">
              <Droplets className="w-3 h-3 text-blue-400" /> Kelembapan
            </div>
            <div className="text-3xl font-bold text-blue-400">{sensorData.kelembaban.toFixed(1)}<span className="text-base text-gray-600">%</span></div>
            <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
              <div className="h-full bg-blue-400 rounded-full transition-all duration-1000"
                style={{ width: `${Math.min(100, sensorData.kelembaban)}%` }} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">

          {/* ── LEFT COLUMN ───────────────────────────────────── */}
          <div className="lg:col-span-4 flex flex-col gap-5">

            {/* Voice Command */}
            <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-4 flex items-center gap-2">
                <Mic className="w-3.5 h-3.5 text-cyan-400" /> Perintah Suara
              </h3>

              {!voiceSupportRef.current && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-4">
                  Browser ini tidak mendukung Web Speech API. Gunakan Chrome / Edge.
                </p>
              )}

              {/* Mic Button */}
              <button
                onClick={voiceActive ? stopVoice : startVoice}
                disabled={!voiceSupportRef.current}
                className={`w-full py-5 rounded-2xl font-bold text-sm uppercase tracking-widest
                            transition-all flex items-center justify-center gap-3 border
                            ${voiceActive
                              ? 'bg-red-500/15 border-red-500/40 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.2)]'
                              : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 hover:shadow-[0_0_20px_rgba(0,242,255,0.15)]'}
                            disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                {voiceActive
                  ? <><span className="relative flex w-2.5 h-2.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"/><span className="relative rounded-full h-2.5 w-2.5 bg-red-400"/></span>Berhenti</>
                  : <><Mic className="w-4 h-4" />Mulai Bicara</>}
              </button>

              {/* Transcript area */}
              <div className="mt-3 min-h-[48px] bg-black/30 border border-white/5 rounded-xl px-4 py-3">
                {voiceActive && !transcript && (
                  <span className="text-xs text-gray-600 italic animate-pulse">Mendengarkan...</span>
                )}
                {transcript && (
                  <span className="text-xs text-gray-300">"{transcript}"</span>
                )}
                {!voiceActive && voiceResult && (
                  <span className={`text-xs font-mono ${voiceResult.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
                    {voiceResult}
                  </span>
                )}
                {!voiceActive && !voiceResult && !transcript && (
                  <span className="text-xs text-gray-700 italic">Belum ada perintah</span>
                )}
              </div>

              {/* Command hints */}
              <div className="mt-3 space-y-1.5">
                {[
                  '"Nyalakan lampu"  /  "Matikan lampu"',
                  '"Nyalakan lampu 1"  /  "Matikan lampu 3"',
                  '"Berapa suhu / kelembapan"',
                  '"Nyalakan variasi 1 / 2"',
                ].map((hint, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] text-gray-600">
                    <span className="text-cyan-800">▸</span>
                    <span>{hint}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Live Log */}
            <div className="bg-white/3 border border-white/8 rounded-2xl p-5 flex-1">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-4 flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-cyan-400" /> Log Aktivitas
              </h3>
              <div className="space-y-2 h-44 overflow-y-auto">
                {logs.map(l => (
                  <div key={l.id} className="text-[10px] font-mono text-cyan-200/50 border-b border-white/4 pb-1.5">
                    {l.text}
                  </div>
                ))}
                {logs.length === 0 && (
                  <div className="text-[10px] text-gray-700 italic">Menunggu aktivitas...</div>
                )}
              </div>
            </div>
          </div>

          {/* ── RIGHT COLUMN ──────────────────────────────────── */}
          <div className="lg:col-span-8 flex flex-col gap-5">

            {/* Manual Relay Controls */}
            <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 flex items-center gap-2">
                  <Power className="w-3.5 h-3.5 text-cyan-400" /> Kontrol Relay
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => sendCommand('all_on')}
                    className="text-[10px] uppercase tracking-widest font-bold px-4 py-2 rounded-xl
                               bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20
                               hover:border-cyan-400/40 transition-all"
                  >
                    Semua ON
                  </button>
                  <button
                    onClick={() => sendCommand('all_off')}
                    className="text-[10px] uppercase tracking-widest font-bold px-4 py-2 rounded-xl
                               bg-white/4 hover:bg-white/8 text-gray-400 border border-white/10 transition-all"
                  >
                    Semua OFF
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[1, 2, 3, 4].map(num => {
                  const key = `r${num}` as keyof RelayStatus;
                  const isOn = relayStatus[key] === 1;
                  return (
                    <div key={num}
                      className={`rounded-2xl p-4 border transition-all
                        ${isOn
                          ? 'bg-cyan-500/8 border-cyan-500/30 shadow-[0_0_20px_rgba(0,242,255,0.06)]'
                          : 'bg-white/2 border-white/6'}`}
                    >
                      {/* Status indicator */}
                      <div className="flex justify-between items-center mb-4">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                          Relay 0{num}
                        </span>
                        <span className={`w-2 h-2 rounded-full transition-all
                          ${isOn ? 'bg-cyan-400 shadow-[0_0_8px_#22d3ee]' : 'bg-gray-800'}`} />
                      </div>

                      <div className={`text-sm font-bold mb-1 ${isOn ? 'text-cyan-300' : 'text-gray-400'}`}>
                        Lampu {num}
                      </div>
                      <div className="text-[10px] font-mono text-gray-600 uppercase mb-4">
                        {isOn ? 'ON' : 'OFF'}
                      </div>

                      <button
                        onClick={() => sendCommand(`r${num}_${isOn ? 'off' : 'on'}`)}
                        className={`w-full py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-widest
                                    transition-all border
                                    ${isOn
                                      ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/25'
                                      : 'bg-white/4 border-white/8 text-gray-400 hover:bg-white/8'}`}
                      >
                        {isOn ? 'Matikan' : 'Nyalakan'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Lighting Patterns */}
            <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-5 flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-violet-400" /> Pola Lampu
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* V1 */}
                <button
                  onClick={() => sendCommand('v1_on')}
                  className={`p-5 rounded-2xl border text-left transition-all
                    ${relayStatus.v1 === 1
                      ? 'bg-violet-500/12 border-violet-500/40 shadow-[0_0_20px_rgba(139,92,246,0.1)]'
                      : 'bg-white/2 border-white/6 hover:bg-white/4 hover:border-white/12'}`}
                >
                  <div className={`text-sm font-bold mb-1 ${relayStatus.v1 === 1 ? 'text-violet-300' : 'text-white'}`}>
                    DISCO MODE
                  </div>
                  <div className="text-[10px] text-gray-600 uppercase tracking-widest font-mono">Pattern V1</div>
                  {relayStatus.v1 === 1 && (
                    <div className="mt-3 flex gap-1">
                      {[0,1,2,3].map(i => (
                        <div key={i} className="w-1.5 h-4 bg-violet-400 rounded-full animate-pulse"
                          style={{ animationDelay: `${i * 0.1}s` }} />
                      ))}
                    </div>
                  )}
                </button>

                {/* V2 */}
                <button
                  onClick={() => sendCommand('v2_on')}
                  className={`p-5 rounded-2xl border text-left transition-all
                    ${relayStatus.v2 === 1
                      ? 'bg-pink-500/12 border-pink-500/40 shadow-[0_0_20px_rgba(236,72,153,0.1)]'
                      : 'bg-white/2 border-white/6 hover:bg-white/4 hover:border-white/12'}`}
                >
                  <div className={`text-sm font-bold mb-1 ${relayStatus.v2 === 1 ? 'text-pink-300' : 'text-white'}`}>
                    STEP MODE
                  </div>
                  <div className="text-[10px] text-gray-600 uppercase tracking-widest font-mono">Pattern V2</div>
                  {relayStatus.v2 === 1 && (
                    <div className="mt-3 flex gap-1 items-end">
                      {[1,2,3,4].map(i => (
                        <div key={i} className="w-1.5 bg-pink-400 rounded-full animate-pulse"
                          style={{ height: `${i * 4}px`, animationDelay: `${i * 0.15}s` }} />
                      ))}
                    </div>
                  )}
                </button>

                {/* Stop */}
                <button
                  onClick={() => sendCommand('v_stop')}
                  className="p-5 rounded-2xl bg-red-500/8 border border-red-500/20 text-red-400
                             hover:bg-red-500/15 hover:border-red-500/40 transition-all text-left"
                >
                  <div className="text-sm font-bold mb-1">STOP</div>
                  <div className="text-[10px] text-gray-600 uppercase tracking-widest font-mono">Hentikan Pola</div>
                </button>
              </div>
            </div>

            {/* Telegram Notif Status */}
            <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-3 flex items-center gap-2">
                <Send className="w-3.5 h-3.5 text-cyan-400" /> Notifikasi Telegram
              </h3>
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_8px_#4ade80]" />
                <span className="text-xs text-gray-400">
                  Notifikasi otomatis terkirim ke Telegram saat status lampu berubah
                </span>
              </div>
              <div className="mt-2 text-[10px] font-mono text-gray-700">
                Chat ID: {CHAT_ID} · Bot aktif
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
