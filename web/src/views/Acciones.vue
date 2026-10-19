<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import { fechaHora } from '../format';
import { sesion } from '../store';
import TarjetaPropuesta, { type Propuesta } from './TarjetaPropuesta.vue';

interface Accion { id: string; objeto: 'lista' | 'segmento' | 'campana'; nombre: string; estado: 'hecha' | 'deshecha'; creadaEn: string; deshechaEn: string | null; persona: string; esMia: boolean }
const filas = ref<Accion[]>([]);
const propuestas = ref<Propuesta[]>([]);
const cargando = ref(true);
const error = ref(''); const aviso = ref('');
const ocupado = ref<string | null>(null);
const confirmar = ref<string | null>(null);
const ETIQUETA = { lista: 'Lista', segmento: 'Segmento', campana: 'Campaña en borrador' } as const;

async function cargar() {
  try { [filas.value, propuestas.value] = await Promise.all([api<Accion[]>('GET', '/api/panel/acciones'), api<Propuesta[]>('GET', '/api/panel/propuestas')]); } catch (e) { error.value = mensajeError(e); } finally { cargando.value = false; }
}
onMounted(cargar);

async function deshacer(a: Accion) {
  error.value = ''; aviso.value = ''; ocupado.value = a.id;
  try {
    const r = await api<{ estado: string }>('POST', `/api/panel/acciones/${a.id}/deshacer`, {});
    aviso.value = r.estado === 'ya_no_existia' ? 'Ya no existía en Archie Send; la marcamos como deshecha.' : `Deshecho: borramos ${ETIQUETA[a.objeto].toLowerCase()} «${a.nombre}» de Archie Send.`;
    confirmar.value = null; await cargar();
  } catch (e) { error.value = mensajeError(e); confirmar.value = null; } finally { ocupado.value = null; }
}
</script>

<template>
  <header class="encabezado"><h1 class="titulo">Lo que <em>preparó</em> Archie AI</h1></header>
  <p class="sec" style="margin-bottom:12px">Aquí queda todo lo que Archie AI creó en tu Archie Send. Los borradores no se envían solos, y enviar, pausar o borrar siempre te pide confirmación. Puedes deshacerlo mientras la lista siga vacía y la campaña siga en borrador.<span v-if="sesion.yo?.rol !== 'admin'"> Ves solo lo que se creó en tus conversaciones.</span></p>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <p v-if="aviso" class="aviso ok" role="status">{{ aviso }}</p>
  <p v-if="cargando" class="sec" role="status">Cargando…</p>
  <section v-if="propuestas.length" aria-labelledby="conf" style="margin-bottom:16px">
    <h2 id="conf" class="lbl v" style="margin-bottom:8px">Confirmaciones (enviar, pausar, borrar)</h2>
    <div style="display:flex;flex-direction:column;gap:12px"><TarjetaPropuesta v-for="p in propuestas" :key="p.id" :p="p" @cambio="cargar" /></div>
  </section>
  <div v-if="cargando"></div>
  <div v-else-if="!filas.length" class="card"><p style="font-weight:700">{{ propuestas.length ? 'No hay borradores creados.' : 'Todavía no hay acciones.' }}</p><p class="sec">Pídele a Archie AI en Conversaciones, por ejemplo: «crea una lista llamada Clientes VIP».</p></div>
  <div v-else class="card tabla-caja">
    <table class="tabla">
      <caption class="solo-lector">Acciones de Archie AI</caption>
      <thead><tr><th scope="col">Qué</th><th scope="col">Nombre</th><th scope="col">Quién lo pidió</th><th scope="col">Cuándo</th><th scope="col">Estado</th><th scope="col"><span class="solo-lector">Acción</span></th></tr></thead>
      <tbody>
        <tr v-for="a in filas" :key="a.id">
          <td>{{ ETIQUETA[a.objeto] }}</td>
          <td style="overflow-wrap:anywhere">{{ a.nombre }}</td>
          <td>{{ a.persona }}</td>
          <td>{{ fechaHora(a.creadaEn) }}</td>
          <td>{{ a.estado === 'hecha' ? 'Creada' : `Deshecha${a.deshechaEn ? ' · ' + fechaHora(a.deshechaEn) : ''}` }}</td>
          <td>
            <template v-if="a.estado === 'hecha'">
              <button v-if="confirmar !== a.id" class="btn2" type="button" style="min-height:44px" @click="confirmar = a.id">Deshacer</button>
              <span v-else style="display:inline-flex;gap:6px;flex-wrap:wrap">
                <button class="btn" type="button" style="min-height:44px" :disabled="ocupado === a.id" @click="deshacer(a)">Sí, borrar «{{ a.nombre.slice(0, 20) }}»</button>
                <button class="btn2" type="button" style="min-height:44px" @click="confirmar = null">Cancelar</button>
              </span>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
