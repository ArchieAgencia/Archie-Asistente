<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import { sesion } from '../store';
import { fechaHora } from '../format';

interface Clave { id: string; nombre: string; prefijo: string; creadaEn: string; ultimoUso: string | null; revocada: boolean }
const origenes = ref<string[]>([]);
const claves = ref<Clave[]>([]);
const ruta = ref('');
const nuevoOrigen = ref(''); const nuevoNombre = ref('');
const claveNueva = ref<{ nombre: string; clave: string } | null>(null);
const copiada = ref(false);
const error = ref(''); const aviso = ref(''); const ocupado = ref(false);
const quitando = ref('');
const esAdmin = sesion.yo?.rol === 'admin';
const sitio = location.origin;

async function cargar() {
  try {
    const d = await api<{ origenes: string[]; claves: Clave[]; base: string }>('GET', '/api/panel/widget');
    origenes.value = d.origenes; claves.value = d.claves; ruta.value = d.base;
  } catch (x) { error.value = mensajeError(x); }
}
onMounted(cargar);

async function accion(f: () => Promise<void>, ok: string) {
  error.value = ''; aviso.value = ''; ocupado.value = true;
  try { await f(); aviso.value = ok; await cargar(); } catch (x) { error.value = mensajeError(x); } finally { ocupado.value = false; quitando.value = ''; }
}
const agregarOrigen = () => accion(async () => { await api('POST', '/api/panel/widget/origenes', { origen: nuevoOrigen.value.trim() }); nuevoOrigen.value = ''; }, 'Sitio autorizado.');
const quitarOrigen = (o: string) => { if (quitando.value !== o) { quitando.value = o; return; } void accion(async () => { await api('POST', '/api/panel/widget/origenes/quitar', { origen: o }); }, 'Quitamos el sitio: el widget dejó de poder abrirse allí.'); };
const crearClave = () => accion(async () => {
  const r = await api<{ nombre: string; clave: string }>('POST', '/api/panel/widget/claves', { nombre: nuevoNombre.value.trim() });
  claveNueva.value = r; copiada.value = false; nuevoNombre.value = '';
}, 'Clave creada. Cópiala ahora: no se vuelve a mostrar.');
const revocar = (c: Clave) => { if (quitando.value !== c.id) { quitando.value = c.id; return; } void accion(async () => { await api('POST', '/api/panel/widget/claves/quitar', { id: c.id }); }, `Revocamos «${c.nombre}» y cerramos las sesiones que se abrieron con ella.`); };
async function copiar() { try { await navigator.clipboard.writeText(claveNueva.value!.clave); copiada.value = true; } catch { /* se puede copiar a mano */ } }
</script>

<template>
  <header class="encabezado"><h1 class="titulo">Wid<em>get</em></h1></header>
  <p class="sec" style="max-width:760px">Pon a Archie AI dentro de otras herramientas, como Archie Send. Quien chatea es una persona que <b>ya es usuaria de tu cuenta</b>: la herramienta pide, desde su servidor, un enlace de un solo uso para esa persona. En el widget se consulta y se preparan borradores; <b>las acciones sensibles solo se aprueban en este panel</b>, con tu verificación en dos pasos.</p>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <p v-if="aviso" class="aviso ok" role="status">{{ aviso }}</p>
  <p v-if="!esAdmin" class="aviso info">Solo un administrador de tu cuenta puede configurar el widget.</p>

  <template v-else>
    <section class="card" style="margin-top:16px" aria-labelledby="w-sitios">
      <h2 id="w-sitios" class="sub">Sitios <em>autorizados</em></h2>
      <p class="sec" style="margin-top:8px">El widget solo se puede abrir dentro de estos sitios. Sin sitios autorizados, nadie puede incrustarlo. Escribe solo la dirección con https, por ejemplo <span class="mono">https://tuherramienta.com</span> (sin ruta, sin puerto, sin IP).</p>
      <ul v-if="origenes.length" style="list-style:none;margin-top:12px;display:grid;gap:8px">
        <li v-for="o in origenes" :key="o" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:space-between">
          <span class="mono" style="overflow-wrap:anywhere">{{ o }}</span>
          <span style="display:flex;gap:8px">
            <button class="btn2" type="button" :disabled="ocupado" @click="quitarOrigen(o)">{{ quitando === o ? 'Sí, quitar' : 'Quitar' }}</button>
            <button v-if="quitando === o" class="btn2" type="button" @click="quitando = ''">Cancelar</button>
          </span>
        </li>
      </ul>
      <p v-else class="sec" style="margin-top:12px">Todavía no autorizaste ningún sitio.</p>
      <form class="form" style="max-width:560px;margin-top:12px" @submit.prevent="agregarOrigen">
        <div class="campo-grupo"><label class="etq" for="wo">Sitio nuevo</label><input id="wo" v-model="nuevoOrigen" class="campo" required maxlength="260" placeholder="https://tuherramienta.com" autocomplete="off" spellcheck="false"></div>
        <button class="btn" type="submit" :disabled="ocupado">Autorizar sitio</button>
      </form>
    </section>

    <section class="card" style="margin-top:20px" aria-labelledby="w-claves">
      <h2 id="w-claves" class="sub">Claves de <em>incrustación</em></h2>
      <p class="sec" style="margin-top:8px">Cada herramienta anfitriona usa una clave <b>solo en su servidor</b> (nunca en el navegador ni en el código de la página). Si una clave se filtra, revócala: se cierran de inmediato las sesiones que abrió.</p>
      <div v-if="claveNueva" class="aviso alerta" role="status" style="margin-top:12px">
        <p style="font-weight:700">Clave de «{{ claveNueva.nombre }}». Cópiala ahora; no se vuelve a mostrar.</p>
        <p class="mono" style="overflow-wrap:anywhere;margin-top:6px;user-select:all">{{ claveNueva.clave }}</p>
        <p style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn2" type="button" @click="copiar">{{ copiada ? 'Copiada' : 'Copiar' }}</button><button class="btn2" type="button" @click="claveNueva = null">Ya la guardé</button></p>
      </div>
      <ul v-if="claves.length" style="list-style:none;margin-top:12px;display:grid;gap:8px">
        <li v-for="c in claves" :key="c.id" class="card" style="padding:12px 14px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
          <div>
            <p style="font-weight:800;font-size:19px">{{ c.nombre }} <span class="mono" style="font-weight:400;font-size:15px">{{ c.prefijo }}…</span></p>
            <p class="sec" style="font-size:15px">Creada {{ fechaHora(c.creadaEn) }} · {{ c.ultimoUso ? `último uso ${fechaHora(c.ultimoUso)}` : 'sin usar' }}</p>
          </div>
          <span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span class="chip" :class="{ on: !c.revocada }" style="cursor:default">{{ c.revocada ? 'Revocada' : 'Vigente' }}</span>
            <template v-if="!c.revocada">
              <button class="btn2" type="button" :disabled="ocupado" @click="revocar(c)">{{ quitando === c.id ? 'Sí, revocar' : 'Revocar' }}</button>
              <button v-if="quitando === c.id" class="btn2" type="button" @click="quitando = ''">Cancelar</button>
            </template>
          </span>
        </li>
      </ul>
      <p v-else class="sec" style="margin-top:12px">Todavía no hay claves.</p>
      <form class="form" style="max-width:560px;margin-top:12px" @submit.prevent="crearClave">
        <div class="campo-grupo"><label class="etq" for="wn">Nombre de la herramienta</label><input id="wn" v-model="nuevoNombre" class="campo" required maxlength="60" placeholder="Archie Send" autocomplete="off">
          <p class="ayuda">Máximo 5 claves vigentes.</p></div>
        <button class="btn" type="submit" :disabled="ocupado">Crear clave</button>
      </form>
    </section>

    <section class="card" style="margin-top:20px" aria-labelledby="w-ins">
      <h2 id="w-ins" class="sub">Cómo <em>instalarlo</em></h2>
      <p class="sec" style="margin-top:8px">1. En el <b>servidor</b> de la herramienta, cuando una persona abra el asistente, pide el enlace (la clave va solo aquí):</p>
      <pre class="mono" style="overflow:auto;margin-top:8px;padding:12px;background:#F4F5FF;border-radius:12px;font-size:14px">POST {{ sitio }}/api/widget/sesion
Authorization: Bearer aiw_…(tu clave)
Content-Type: application/json

{ "email": "correo-de-la-persona@ejemplo.com" }
→ { "url": "{{ sitio }}{{ ruta }}#c=…", "expiraEnSegundos": 120 }</pre>
      <p class="sec" style="margin-top:12px">2. En la <b>página</b> de la herramienta, carga el script y entrégale una función que pida esa dirección a tu servidor:</p>
      <pre class="mono" style="overflow:auto;margin-top:8px;padding:12px;background:#F4F5FF;border-radius:12px;font-size:14px">&lt;script src="{{ sitio }}/widget.js" async&gt;&lt;/script&gt;
&lt;script&gt;
  window.addEventListener('load', function () {
    ArchieAI.montar({ obtenerUrl: function () {
      return fetch('/mi-servidor/archie-ai-sesion').then(function (r) { return r.json(); }).then(function (j) { return j.url; });
    } });
  });
&lt;/script&gt;</pre>
      <p class="sec" style="margin-top:12px">La persona debe existir como usuaria de tu cuenta de Archie AI con ese correo. La sesión del widget dura 2 horas; al vencer, se pide un enlace nuevo solo. Encuentras la guía paso a paso en el centro de ayuda.</p>
    </section>
  </template>
</template>
