<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, mensajeError } from '../api';
import { fechaHora } from '../format';
import { sesion } from '../store';

export interface Propuesta { id: string; accion: string; nombre: string; texto: string; estado: 'pendiente' | 'ejecutando' | 'ejecutada' | 'fallida' | 'rechazada' | 'expirada'; codigo: string | null; expiraEn: string; puedeAprobar?: boolean }
const props = defineProps<{ p: Propuesta }>();
const emit = defineEmits<{ cambio: [] }>();

const ocupado = ref(false); const error = ref('');
const esAdmin = computed(() => sesion.yo?.rol === 'admin');
const BOTON: Record<string, string> = {
  enviar_ahora: 'Sí, enviar ahora', programar: 'Sí, programar el envío', pausar: 'Sí, pausar', reanudar: 'Sí, reanudar', cancelar: 'Sí, cancelar la campaña', borrar: 'Sí, borrar la campaña',
};
const ESTADO: Record<string, string> = {
  ejecutada: 'Hecho. Revisa el resultado en Archie Send.', rechazada: 'Rechazada: no se hizo nada.', expirada: 'Venció: no se hizo nada. Pídele a Archie AI una tarjeta nueva.',
  ejecutando: 'En ejecución… Si no termina, revisa la campaña en Archie Send antes de volver a pedirlo.',
  fallida: 'No se pudo completar. Revisa la campaña en Archie Send; si hace falta, pide una tarjeta nueva.',
};

async function aprobar() {
  error.value = ''; ocupado.value = true;
  try { await api('POST', `/api/panel/propuestas/${props.p.id}/aprobar`, {}); } catch (e) { error.value = mensajeError(e); } finally { ocupado.value = false; emit('cambio'); }
}
async function rechazar() {
  error.value = ''; ocupado.value = true;
  try { await api('POST', `/api/panel/propuestas/${props.p.id}/rechazar`, {}); } catch (e) { error.value = mensajeError(e); } finally { ocupado.value = false; emit('cambio'); }
}
</script>

<template>
  <section class="tarjeta" :aria-label="`Tarjeta de confirmación: ${p.nombre}`">
    <p class="lbl v">Confirmación necesaria</p>
    <p class="tarjeta-texto">{{ p.texto }}</p>
    <template v-if="p.estado === 'pendiente'">
      <p class="sec" style="font-size:15px;margin-top:6px">Vence a las {{ fechaHora(p.expiraEn) }}. Archie AI no ejecuta nada hasta que la apruebes.</p>
      <div v-if="esAdmin" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="btn" type="button" style="min-height:44px" :disabled="ocupado" @click="aprobar">{{ BOTON[p.accion] ?? 'Aprobar' }}</button>
        <button class="btn2" type="button" style="min-height:44px" :disabled="ocupado" @click="rechazar">No, rechazar</button>
      </div>
      <p v-else class="sec" style="margin-top:8px">Un administrador de tu cuenta debe aprobarla (la verá en <router-link to="/acciones">Acciones</router-link>).</p>
    </template>
    <p v-else class="tarjeta-estado" role="status">{{ ESTADO[p.estado] ?? p.estado }}</p>
    <p v-if="error" class="aviso error" role="alert" style="margin-top:8px">{{ error }}</p>
  </section>
</template>

<style scoped>
.tarjeta { border: 2px solid var(--accion); max-width: 760px; border-radius: 16px; padding: 12px 16px; background: #fff; }
.tarjeta-texto { white-space: pre-line; overflow-wrap: anywhere; margin-top: 6px; font-weight: 600; }
.tarjeta-estado { margin-top: 8px; font-weight: 700; }
</style>
