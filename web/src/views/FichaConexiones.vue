<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import ModalCodigo from '../componentes/ModalCodigo.vue';
import { ETIQUETA_CONECTOR, fechaHora } from '../format';
import { sesion } from '../store';

interface Conexion { id: string; conector: string; nombre: string; origen: string | null; probadaEn: string | null; pruebaOk: boolean | null; creadaEn: string; rotadaEn: string | null }
const props = defineProps<{ orgId: string }>();
const emit = defineEmits<{ cambio: [] }>();
const lista = ref<Conexion[]>([]); const error = ref(''); const aviso = ref(''); const cargado = ref(false);
const quitar = ref<Conexion | null>(null); const errModal = ref(''); const ocupado = ref(false);
const puedeQuitar = () => ['admin', 'soporte'].includes(sesion.operador?.rol ?? '');

async function cargar() {
  try { lista.value = await api('GET', `/api/consola/clientes/${props.orgId}/conexiones`); }
  catch (e) { error.value = mensajeError(e); } finally { cargado.value = true; }
}
onMounted(cargar);
const estado = (c: Conexion) => (c.pruebaOk === true ? 'ok' : c.pruebaOk === false ? 'falla' : 'sin');
const ETQ = { ok: 'Funciona', falla: 'Falla', sin: 'Sin probar' } as const;

async function confirmar(codigo: string) {
  errModal.value = ''; ocupado.value = true;
  try {
    await api('POST', `/api/consola/clientes/${props.orgId}/conexiones/quitar`, { id: quitar.value!.id, codigo });
    quitar.value = null; aviso.value = 'Quitamos la conexión. Quedó registrado en la bitácora del cliente.';
    await cargar(); emit('cambio');
  } catch (e) { errModal.value = mensajeError(e); } finally { ocupado.value = false; }
}
</script>

<template>
  <section class="card tabla-caja" aria-labelledby="cx">
    <h2 id="cx" class="sub" style="padding:20px 24px 4px"><em>Conexiones</em> del cliente</h2>
    <p class="sec" style="padding:0 24px 12px;font-size:16px">Solo vemos el estado de cada conexión. Las claves nunca se muestran. Solo se quita una que la última prueba marcó como fallida.</p>
    <p v-if="error" class="aviso error" role="alert" style="margin:0 24px 12px">{{ error }}</p>
    <p v-if="aviso" class="aviso ok" role="status" style="margin:0 24px 12px">{{ aviso }}</p>
    <table v-if="lista.length" class="tabla" style="min-width:680px">
      <thead><tr><th>Conexión</th><th>Estado</th><th>Última prueba</th><th></th></tr></thead>
      <tbody><tr v-for="c in lista" :key="c.id">
        <td><b>{{ ETIQUETA_CONECTOR[c.conector] ?? c.conector }}</b><span class="sec"> · {{ c.nombre }}</span><div v-if="c.origen" class="sec mono" style="font-size:14px">{{ c.origen }}</div></td>
        <td><span class="est" :class="{ 'e-activo': estado(c) === 'ok', 'e-sin_saldo': estado(c) === 'falla', 'e-prueba': estado(c) === 'sin' }">{{ ETQ[estado(c)] }}</span></td>
        <td>{{ c.probadaEn ? fechaHora(c.probadaEn) : '—' }}</td>
        <td><button v-if="puedeQuitar() && c.pruebaOk === false" class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" @click="errModal = ''; quitar = c">Quitar</button></td>
      </tr></tbody>
    </table>
    <p v-else-if="cargado && !error" class="sec" style="padding:0 24px 20px">Este cliente todavía no conectó nada.</p>
    <ModalCodigo v-if="quitar" titulo="Quitar conexión" :ocupado="ocupado" :error="errModal" peligro @confirmar="confirmar" @cancelar="quitar = null">
      <p>Quitar la conexión <b>{{ ETIQUETA_CONECTOR[quitar.conector] ?? quitar.conector }}</b> ({{ quitar.nombre }}), que está fallando. El cliente tendrá que volver a conectarla con una clave nueva. Queda en su bitácora.</p>
    </ModalCodigo>
  </section>
</template>
