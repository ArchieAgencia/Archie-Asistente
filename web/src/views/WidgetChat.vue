<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

interface Mensaje { rol: 'user' | 'assistant'; texto: string }
const estado = ref<'cargando' | 'listo' | 'sin_acceso'>('cargando');
const mensajes = ref<Mensaje[]>([]);
const avisos = ref<string[]>([]);
const texto = ref('');
const enviando = ref(false);
const consultando = ref(false);
const error = ref('');
const sinConexion = ref(false);
const registro = ref<HTMLElement | null>(null);
let token = ''; // solo en memoria de este iframe: nunca en almacenamiento del navegador
let conversacion: string | null = null;
let ctl: AbortController | null = null;

const avisarPadre = (tipo: string) => { try { window.parent.postMessage({ tipo }, '*'); } catch { /* sin padre */ } };
const bajar = async () => { await nextTick(); registro.value?.scrollTo({ top: registro.value.scrollHeight }); };
const expirar = () => { token = ''; estado.value = 'sin_acceso'; avisarPadre('archie:expirado'); };

onMounted(async () => {
  const m = /[#&]c=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  history.replaceState(null, '', location.pathname); // el enlace de un solo uso no se queda en la dirección
  if (!m) { estado.value = 'sin_acceso'; return; }
  try {
    const r = await fetch('/api/widget/canjear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canje: m[1] }) });
    if (!r.ok) throw new Error('canje');
    token = ((await r.json()) as { token: string }).token;
    estado.value = 'listo';
    const e = await fetch('/api/widget/estado', { headers: { Authorization: `Bearer ${token}` } });
    if (e.status === 401) return expirar();
    sinConexion.value = e.ok && !((await e.json()) as { conectado: boolean }).conectado;
  } catch { estado.value = 'sin_acceso'; }
});
onBeforeUnmount(() => ctl?.abort());

const ERRORES: Record<string, string> = {
  sin_conexion: 'Todavía no hay nada conectado. Pide a un administrador que conecte Archie Send, una tienda, tu pauta o una herramienta de la suite en el panel de Archie AI.',
  saldo_insuficiente: 'Se acabaron las consultas de tu plan. Un administrador puede ver el detalle en el panel de Archie AI.',
  demasiados_intentos: 'Vas muy rápido. Espera un minuto.',
  ia_proveedor_no_disponible: 'El asistente no está disponible ahora mismo. No gastaste la consulta; inténtalo en un minuto.',
  ia_tiempo_agotado: 'La respuesta tardó demasiado. Inténtalo de nuevo.',
};

async function enviar() {
  const t = texto.value.trim();
  if (!t || enviando.value || !token) return;
  error.value = ''; enviando.value = true; texto.value = '';
  mensajes.value.push({ rol: 'user', texto: t }, { rol: 'assistant', texto: '' });
  const mia = mensajes.value[mensajes.value.length - 1]!;
  await bajar();
  ctl = new AbortController();
  try {
    const r = await fetch('/api/widget/chat', {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ texto: t, ...(conversacion ? { conversacionId: conversacion } : {}) }),
    });
    if (r.status === 401) { mensajes.value.splice(-2); texto.value = t; return expirar(); }
    if (!r.ok || !r.body) {
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      error.value = ERRORES[d.error ?? ''] ?? 'No pudimos responder. Inténtalo de nuevo.';
      mensajes.value.splice(-2); texto.value = t; return;
    }
    const lector = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const bloque = buf.slice(0, i); buf = buf.slice(i + 2);
        const linea = bloque.split('\n').find((l) => l.startsWith('data: '));
        if (!linea) continue;
        let ev: { tipo: string; [k: string]: unknown };
        try { ev = JSON.parse(linea.slice(6)); } catch { continue; }
        if (ev.tipo === 'inicio') conversacion = String(ev.conversacionId);
        else if (ev.tipo === 'texto') { mia.texto += String(ev.delta); await bajar(); }
        else if (ev.tipo === 'herramienta') consultando.value = ev.estado === 'consultando';
        else if (ev.tipo === 'propuesta') avisos.value.push('Preparé una acción que necesita tu aprobación. Se aprueba en el panel de Archie AI, nunca desde aquí.');
        else if (ev.tipo === 'accion') avisos.value.push(`Preparé un borrador («${String(ev.nombre)}»). No se envió nada; puedes deshacerlo en el panel de Archie AI.`);
        else if (ev.tipo === 'error') { error.value = ERRORES[String(ev.codigo)] ?? 'Algo salió mal. Inténtalo de nuevo.'; if (!mia.texto) mensajes.value.pop(); }
      }
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) { error.value = 'No pudimos conectar. Inténtalo de nuevo.'; if (!mia.texto) mensajes.value.pop(); }
  } finally { enviando.value = false; consultando.value = false; ctl = null; await bajar(); }
}
function nueva() { conversacion = null; mensajes.value = []; avisos.value = []; error.value = ''; }
function teclas(ev: KeyboardEvent) { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void enviar(); } }
</script>

<template>
  <div class="w">
    <header class="w-cab">
      <strong>Archie <em>AI</em></strong>
      <span class="w-acc">
        <button v-if="mensajes.length" type="button" class="w-btn" @click="nueva">Nueva</button>
        <button type="button" class="w-btn" aria-label="Cerrar el asistente" @click="avisarPadre('archie:cerrar')">✕</button>
      </span>
    </header>

    <p v-if="estado === 'cargando'" class="w-sec" role="status">Abriendo el asistente…</p>
    <p v-else-if="estado === 'sin_acceso'" class="w-aviso" role="alert">La sesión del asistente terminó o el enlace ya se usó. Cierra esta ventana y vuelve a abrirla desde la herramienta.</p>
    <template v-else>
      <p v-if="sinConexion" class="w-aviso" role="status">Todavía no hay nada conectado. Pide a un administrador que conecte Archie Send, una tienda, tu pauta o una herramienta de la suite en el panel de Archie AI.</p>
      <div ref="registro" class="w-log" role="log" aria-live="polite">
        <p v-if="!mensajes.length" class="w-sec">Pregúntame por tus campañas, tus listas, tu tienda o tu pauta. Cada pregunta usa 1 consulta de tu plan.</p>
        <div v-for="(m, i) in mensajes" :key="i" class="w-b" :class="m.rol === 'user' ? 'yo' : 'ia'">
          <span class="w-lbl">{{ m.rol === 'user' ? 'Tú' : 'Archie AI' }}</span>
          <p>{{ m.texto || (enviando && i === mensajes.length - 1 ? 'Pensando…' : '') }}</p>
        </div>
        <p v-if="consultando" class="w-sec" role="status">Consultando tus datos…</p>
        <p v-for="(a, i) in avisos" :key="i" class="w-aviso">{{ a }}</p>
      </div>
      <p v-if="error" class="w-error" role="alert">{{ error }}</p>
      <form class="w-form" @submit.prevent="enviar">
        <label class="solo-lector" for="wm">Escribe tu pregunta</label>
        <textarea id="wm" v-model="texto" rows="2" maxlength="4000" placeholder="Escribe tu pregunta" :disabled="enviando || sinConexion" @keydown="teclas" />
        <button v-if="!enviando" class="w-env" type="submit" :disabled="!texto.trim() || sinConexion">Enviar</button>
        <button v-else class="w-env" type="button" @click="ctl?.abort()">Detener</button>
      </form>
    </template>
  </div>
</template>

<style scoped>
.w { display: flex; flex-direction: column; height: 100vh; background: #fff; color: #131126; font-family: 'Dosis', 'Trebuchet MS', Arial, sans-serif; font-size: 17px; }
.w-cab { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #131126; color: #D9EBFF; }
.w-cab em { color: #B5BAFE; font-style: normal; }
.w-acc { display: flex; gap: 6px; }
.w-btn { min-width: 44px; min-height: 36px; border: 1px solid #6265FE; border-radius: 999px; background: transparent; color: #D9EBFF; font: inherit; cursor: pointer; }
.w-log { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.w-b { max-width: 92%; border-radius: 14px; padding: 8px 12px; border: 1px solid #E4E6FB; }
.w-b.yo { align-self: flex-end; background: #F0F0FF; }
.w-b.ia { align-self: flex-start; background: #fff; }
.w-b p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 2px 0 0; }
.w-lbl { font-size: 13px; font-weight: 700; color: #6265FE; text-transform: uppercase; letter-spacing: .04em; }
.w-sec { color: #55557A; padding: 12px 14px; margin: 0; }
.w-aviso { margin: 8px 14px; padding: 8px 12px; border-radius: 10px; background: #F0F0FF; border-left: 4px solid #6265FE; }
.w-error { margin: 0 14px 6px; color: #8A1C1C; }
.w-form { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid #E4E6FB; }
.w-form textarea { flex: 1; resize: none; border: 1px solid #B5BAFE; border-radius: 12px; padding: 8px 12px; font: inherit; }
.w-env { min-width: 80px; border: 0; border-radius: 999px; background: #6265FE; color: #fff; font: 600 17px 'Dosis', sans-serif; cursor: pointer; }
.w-env:disabled { opacity: .5; cursor: default; }
</style>
