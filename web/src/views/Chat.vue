<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ErrorApi, mensajeError } from '../api';
import { num } from '../format';
import TarjetaPropuesta, { type Propuesta } from './TarjetaPropuesta.vue';

interface Conversacion { id: string; titulo: string; actualizadaEn: string }
interface Mensaje { rol: 'user' | 'assistant'; texto: string; herramientas: string[] }
interface Accion { id: string; objeto: 'lista' | 'segmento' | 'campana'; nombre: string; estado: 'hecha' | 'deshecha' }
const ETIQUETA_OBJETO = { lista: 'la lista', segmento: 'el segmento', campana: 'la campaña en borrador' } as const;
const acciones = ref<Accion[]>([]);
const propuestas = ref<Propuesta[]>([]);
async function refrescarPropuestas() {
  if (!actual.value) return;
  try { propuestas.value = (await api<{ propuestas: Propuesta[] }>('GET', `/api/panel/chat/conversaciones/${actual.value}`)).propuestas; } catch (e) { error.value = mensajeError(e); }
}
const confirmando = ref<string | null>(null);
const deshaciendo = ref<string | null>(null);

const lista = ref<Conversacion[]>([]);
const actual = ref<string | null>(null);
const mensajes = ref<Mensaje[]>([]);
const texto = ref('');
const enviando = ref(false);
const consultando = ref('');
const error = ref(''); const aviso = ref('');
const saldo = ref<number | null>(null);
const sinConexion = ref(false);
const registro = ref<HTMLElement | null>(null);
let ctl: AbortController | null = null;

const HERRAMIENTA: Record<string, string> = {
  send_listas: 'tus listas', send_campanas: 'tus campañas', send_campana: 'una campaña', send_campanas_en_curso: 'los envíos en curso',
  send_segmentos: 'tus segmentos', send_creditos: 'tus créditos', send_errores_envio: 'los errores de envío', send_contactos: 'tus contactos',
  tiendas_conectadas: 'tus tiendas', tienda_resumen_ventas: 'las ventas de tu tienda', tienda_pedidos: 'los pedidos de tu tienda', tienda_pedido: 'un pedido', tienda_productos: 'los productos de tu tienda',
  tienda_producto: 'un producto', tienda_stock_bajo: 'el stock de tu tienda', tienda_mas_vendidos: 'los más vendidos', tienda_cupones: 'los cupones de tu tienda',
  pauta_cuentas: 'tus cuentas de pauta', pauta_resumen: 'el resumen de tu pauta', pauta_ranking: 'el ranking de tus campañas', pauta_comparar: 'la comparación de tu pauta',
  talk_metricas: 'la atención en Archie Talk', talk_conversaciones: 'tus conversaciones de Archie Talk', talk_embudo: 'tu embudo de ventas', talk_tratos: 'tus tratos',
  meet_reuniones: 'tus reuniones de Archie Meet', meet_uso: 'el uso de Archie Meet',
  booking_tipos: 'tus tipos de cita', booking_disponibilidad: 'los espacios libres de tu agenda', booking_reservas: 'tus reservas', booking_resumen: 'el resumen de tu agenda',
  send_proponer_accion_campana: 'preparar una confirmación', send_crear_lista: 'crear una lista', send_crear_segmento: 'crear un segmento', send_crear_borrador_campana: 'crear un borrador de campaña',
};
const ERROR_SSE: Record<string, string> = {
  ia_proveedor_no_disponible: 'El asistente no está disponible ahora mismo. No gastaste la consulta; inténtalo en un minuto.',
  ia_proveedor_rechazo: 'El asistente no pudo procesar el mensaje. Escríbenos si se repite.',
  ia_tiempo_agotado: 'La respuesta tardó demasiado. Inténtalo de nuevo.',
  ia_respuesta_invalida: 'No pude leer la respuesta del asistente. Inténtalo de nuevo.',
  send_no_conectado: 'Archie Send no está conectado. Un administrador debe conectarlo en Conexiones.',
  tienda_credencial_rechazada: 'Una tienda rechazó las credenciales conectadas. Un administrador debe revisarlas en Conexiones.',
  tienda_no_conectada: 'Esa tienda no está conectada. Un administrador debe conectarla en Conexiones.',
  pauta_credencial_rechazada: 'Una cuenta de pauta rechazó el token conectado. Un administrador debe revisarlo en Conexiones.',
  pauta_no_conectada: 'Esa cuenta de pauta no está conectada. Un administrador debe conectarla en Conexiones.',
  suite_credencial_rechazada: 'Una herramienta de la suite rechazó la clave conectada. Un administrador debe revisarla en Conexiones.',
  suite_no_conectada: 'Esa herramienta de la suite no está conectada. Un administrador debe conectarla en Conexiones.',
  error_interno: 'Algo salió mal de nuestro lado. Inténtalo de nuevo.',
};
const SUGERENCIAS = ['¿Cuántos créditos me quedan?', '¿Cómo van mis campañas?', '¿Hubo errores de envío esta semana?', 'Crea una lista llamada Clientes VIP', '¿Cómo van las ventas de la tienda este mes?', '¿Qué productos tienen poco stock?', '¿Cuánto gastamos en pauta esta semana y qué campaña rinde mejor?'];

const bajar = async () => { await nextTick(); registro.value?.scrollTo({ top: registro.value.scrollHeight }); };

async function cargarLista() { try { lista.value = await api<Conversacion[]>('GET', '/api/panel/chat/conversaciones'); } catch (e) { error.value = mensajeError(e); } }
onMounted(async () => {
  void cargarLista();
  try {
    const [send, t, pa, su] = await Promise.all([api<{ conectado: boolean }>('GET', '/api/panel/conexiones'), api<{ tiendas: unknown[] }>('GET', '/api/panel/tiendas'), api<{ cuentas: unknown[] }>('GET', '/api/panel/pauta'), api<{ conexiones: unknown[] }>('GET', '/api/panel/suite')]);
    sinConexion.value = !send.conectado && t.tiendas.length === 0 && pa.cuentas.length === 0 && su.conexiones.length === 0;
  } catch { /* se verá al enviar */ }
});
onBeforeUnmount(() => ctl?.abort());

async function abrir(id: string) {
  error.value = ''; aviso.value = '';
  try {
    const c = await api<{ id: string; mensajes: Mensaje[]; acciones: Accion[]; propuestas: Propuesta[] }>('GET', `/api/panel/chat/conversaciones/${id}`);
    actual.value = c.id; mensajes.value = c.mensajes; acciones.value = c.acciones; propuestas.value = c.propuestas; confirmando.value = null; await bajar();
  } catch (e) { error.value = mensajeError(e); }
}
function nueva() { actual.value = null; mensajes.value = []; acciones.value = []; propuestas.value = []; confirmando.value = null; error.value = ''; aviso.value = ''; }
async function borrar(c: Conversacion) {
  try {
    await api('POST', `/api/panel/chat/conversaciones/${c.id}/borrar`, {});
    if (actual.value === c.id) nueva();
    aviso.value = 'Borramos la conversación.'; await cargarLista();
  } catch (e) { error.value = mensajeError(e); }
}

async function enviar(pregunta?: string) {
  const t = (pregunta ?? texto.value).trim();
  if (!t || enviando.value) return;
  error.value = ''; aviso.value = ''; enviando.value = true; texto.value = '';
  mensajes.value.push({ rol: 'user', texto: t, herramientas: [] });
  const respuesta: Mensaje = { rol: 'assistant', texto: '', herramientas: [] };
  mensajes.value.push(respuesta);
  const mia = mensajes.value[mensajes.value.length - 1]!; // objeto reactivo
  await bajar();
  ctl = new AbortController();
  try {
    const r = await fetch('/api/panel/chat', {
      method: 'POST', credentials: 'same-origin', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: t, ...(actual.value ? { conversacionId: actual.value } : {}) }),
    });
    if (!r.ok || !r.body) {
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      throw new ErrorApi(r.status, d.error ?? 'error');
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
        if (ev.tipo === 'inicio') actual.value = String(ev.conversacionId);
        else if (ev.tipo === 'propuesta') { await refrescarPropuestas(); await bajar(); }
        else if (ev.tipo === 'accion') { acciones.value.push({ id: String(ev.id), objeto: ev.objeto as Accion['objeto'], nombre: String(ev.nombre), estado: 'hecha' }); await bajar(); }
        else if (ev.tipo === 'texto') { mia.texto += String(ev.delta); await bajar(); }
        else if (ev.tipo === 'herramienta') {
          const nombre = HERRAMIENTA[String(ev.nombre)] ?? 'tus datos';
          if (ev.estado === 'consultando') { consultando.value = nombre; if (!mia.herramientas.includes(String(ev.nombre))) mia.herramientas.push(String(ev.nombre)); } else consultando.value = '';
        } else if (ev.tipo === 'fin') saldo.value = Number(ev.saldo);
        else if (ev.tipo === 'error') { error.value = ERROR_SSE[String(ev.codigo)] ?? ERROR_SSE.error_interno!; if (!mia.texto) mensajes.value.pop(); }
      }
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      error.value = mensajeError(e);
      if (e instanceof ErrorApi && e.codigo === 'sin_conexion') sinConexion.value = true;
      if (!mia.texto) mensajes.value.pop();
      if (e instanceof ErrorApi && e.estado !== 200) { const u = mensajes.value.at(-1); if (u?.rol === 'user' && u.texto === t) { mensajes.value.pop(); texto.value = t; } }
    }
  } finally {
    enviando.value = false; consultando.value = ''; ctl = null;
    await cargarLista(); await bajar();
  }
}
const detener = () => ctl?.abort();
async function deshacer(a: Accion) {
  error.value = ''; aviso.value = ''; deshaciendo.value = a.id;
  try {
    await api('POST', `/api/panel/acciones/${a.id}/deshacer`, {});
    a.estado = 'deshecha'; aviso.value = `Deshecho: borramos ${ETIQUETA_OBJETO[a.objeto]} «${a.nombre}» de Archie Send.`;
  } catch (e) { error.value = mensajeError(e); } finally { deshaciendo.value = null; confirmando.value = null; }
}
function teclas(ev: KeyboardEvent) { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void enviar(); } }
</script>

<template>
  <header class="encabezado"><h1 class="titulo">Conver<em>saciones</em></h1><button class="btn2" type="button" @click="nueva">Nueva conversación</button></header>
  <p v-if="sinConexion" class="aviso alerta" role="status">Aún no hay nada conectado. <router-link to="/conexiones">Conecta Archie Send, una tienda o una cuenta de pauta en Conexiones</router-link> para empezar a preguntar.</p>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <p v-if="aviso" class="aviso ok" role="status">{{ aviso }}</p>

  <div class="chat">
    <aside class="card chat-lista" aria-label="Tus conversaciones">
      <p class="lbl v">Tus conversaciones</p>
      <p v-if="!lista.length" class="sec" style="margin-top:8px;font-size:16px">Aún no tienes conversaciones. Se borran solas a los 30 días.</p>
      <ul v-else style="list-style:none;margin:8px 0 0;padding:0">
        <li v-for="c in lista" :key="c.id" style="display:flex;gap:6px;align-items:center">
          <button type="button" class="chat-item" :class="{ on: c.id === actual }" :aria-current="c.id === actual ? 'true' : undefined" @click="abrir(c.id)">{{ c.titulo }}</button>
          <button type="button" class="chat-x" :aria-label="`Borrar la conversación ${c.titulo}`" @click="borrar(c)">✕</button>
        </li>
      </ul>
    </aside>

    <section class="card chat-main" aria-label="Conversación actual">
      <div ref="registro" class="chat-log" role="log" aria-live="polite" aria-relevant="additions text">
        <div v-if="!mensajes.length" class="chat-vacio">
          <p style="font-size:22px;font-weight:700">¿Qué quieres saber de tu negocio?</p>
          <p class="sec" style="margin-top:6px">Consulto tu Archie Send, tus tiendas en línea y tu pauta en Meta y TikTok (tiendas y pauta, solo para leer: sin datos personales de tus compradores ni de tu audiencia). En Archie Send también preparo borradores que puedes deshacer. Para enviar, pausar o borrar, te muestro una tarjeta y solo actúo si la apruebas. Prueba con una pregunta:</p>
          <div class="chips" style="margin-top:12px"><button v-for="s in SUGERENCIAS" :key="s" type="button" class="chip" :disabled="enviando || sinConexion" @click="enviar(s)">{{ s }}</button></div>
        </div>
        <div v-for="(m, i) in mensajes" :key="i" class="burbuja" :class="m.rol === 'user' ? 'yo' : 'ia'">
          <p class="lbl" :class="{ v: m.rol === 'assistant' }">{{ m.rol === 'user' ? 'Tú' : 'Archie AI' }}</p>
          <p class="burbuja-texto">{{ m.texto || (enviando && i === mensajes.length - 1 ? 'Pensando…' : '') }}</p>
          <p v-if="m.herramientas.length" class="sec" style="font-size:15px;margin-top:4px">Consulté: {{ m.herramientas.map((h) => HERRAMIENTA[h] ?? h).join(', ') }}</p>
        </div>
        <p v-if="consultando" class="sec" role="status">Consultando {{ consultando }}…</p>
        <TarjetaPropuesta v-for="p in propuestas" :key="p.id" :p="p" @cambio="refrescarPropuestas" />
        <section v-if="acciones.length" class="burbuja ia acciones-caja" aria-label="Lo que se creó en esta conversación">
          <p class="lbl v">Lo que preparé en esta conversación</p>
          <ul style="list-style:none;margin:6px 0 0;padding:0">
            <li v-for="a in acciones" :key="a.id" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
              <span style="overflow-wrap:anywhere">{{ a.estado === 'hecha' ? 'Creé' : 'Deshecho:' }} {{ ETIQUETA_OBJETO[a.objeto] }} «{{ a.nombre }}»<span v-if="a.objeto === 'campana' && a.estado === 'hecha'"> (no se envió)</span></span>
              <template v-if="a.estado === 'hecha'">
                <button v-if="confirmando !== a.id" class="btn2" type="button" style="min-height:44px" @click="confirmando = a.id">Deshacer</button>
                <template v-else>
                  <button class="btn" type="button" style="min-height:44px" :disabled="deshaciendo === a.id" @click="deshacer(a)">Sí, borrarlo</button>
                  <button class="btn2" type="button" style="min-height:44px" @click="confirmando = null">Cancelar</button>
                </template>
              </template>
            </li>
          </ul>
          <p class="sec" style="font-size:15px;margin-top:6px">Todo queda en <router-link to="/acciones">Acciones</router-link>.</p>
        </section>
      </div>

      <form class="chat-form" @submit.prevent="enviar()">
        <label class="solo-lector" for="mensaje">Escribe tu pregunta</label>
        <textarea id="mensaje" v-model="texto" class="campo" rows="2" maxlength="4000" placeholder="Escribe tu pregunta (Enter envía, Mayús+Enter salto de línea)" :disabled="enviando || sinConexion" style="padding:10px 14px;resize:vertical" @keydown="teclas" />
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button v-if="!enviando" class="btn" type="submit" :disabled="!texto.trim() || sinConexion">Enviar</button>
          <button v-else class="btn2" type="button" @click="detener">Detener</button>
          <span class="sec" style="font-size:15px">Cada pregunta usa 1 consulta<span v-if="saldo !== null"> · te quedan {{ num(saldo) }}</span>.</span>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.chat { display: grid; grid-template-columns: 280px 1fr; gap: 16px; align-items: start; }
.chat-lista { position: sticky; top: 16px; max-height: calc(100vh - 140px); overflow: auto; }
.chat-main { display: flex; flex-direction: column; gap: 12px; min-height: 520px; }
.chat-log { flex: 1; overflow-y: auto; max-height: calc(100vh - 360px); min-height: 320px; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
.chat-vacio { margin: auto 0; padding: 12px 0; }
.chat-item { flex: 1; text-align: left; min-height: 44px; padding: 6px 12px; border-radius: 10px; border: 1px solid transparent; background: transparent; font: 600 16px 'Dosis', sans-serif; color: var(--navy); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-item.on { background: var(--fondo-v); border-color: var(--accion); color: var(--texto-v); }
.chat-x { min-width: 44px; min-height: 44px; border: 0; background: transparent; color: var(--sec); cursor: pointer; font-size: 16px; border-radius: 10px; }
.burbuja { max-width: 760px; border-radius: 16px; padding: 12px 16px; }
.burbuja.yo { align-self: flex-end; background: var(--fondo-v); border: 1px solid var(--linea); }
.burbuja.ia { align-self: flex-start; background: #fff; border: 1px solid var(--linea); }
.burbuja-texto { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
.chat-form { display: flex; flex-direction: column; gap: 8px; }
@media (max-width: 860px) { .chat { grid-template-columns: 1fr; } .chat-lista { position: static; max-height: 240px; } }
</style>
