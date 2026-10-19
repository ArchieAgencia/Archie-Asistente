<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import ModalCodigo from '../componentes/ModalCodigo.vue';
import { fechaHora } from '../format';
import { sesion } from '../store';

interface Clave { id: string; nombre: string; prefijo: string; creadaEn: string; ultimoUso: string | null; revocada: boolean }
const props = defineProps<{ orgId: string }>();
const w = ref<{ origenes: Array<{ origen: string; creadoEn: string }>; claves: Clave[]; sesionesActivas: number } | null>(null);
const error = ref(''); const aviso = ref('');
const revocar = ref<Clave | null>(null); const errModal = ref(''); const ocupado = ref(false);
const puede = () => ['admin', 'soporte'].includes(sesion.operador?.rol ?? '');
async function cargar() { try { w.value = await api('GET', `/api/consola/clientes/${props.orgId}/widget`); } catch (e) { error.value = mensajeError(e); } }
onMounted(cargar);
async function confirmar(codigo: string) {
  errModal.value = ''; ocupado.value = true;
  try {
    await api('POST', `/api/consola/clientes/${props.orgId}/widget/revocar`, { clave: revocar.value!.id, codigo });
    revocar.value = null; aviso.value = 'Revocamos la clave y cerramos sus sesiones. Quedó en la bitácora del cliente.'; await cargar();
  } catch (e) { errModal.value = mensajeError(e); } finally { ocupado.value = false; }
}
</script>

<template>
  <section class="card tabla-caja" aria-labelledby="wd">
    <h2 id="wd" class="sub" style="padding:20px 24px 4px"><em>Widget</em> y claves</h2>
    <p class="sec" style="padding:0 24px 12px;font-size:16px">Los sitios donde el cliente puede incrustar Archie AI y las claves que usa su herramienta. Nunca se muestra el valor de una clave: solo su inicio, para reconocerla.</p>
    <p v-if="error" class="aviso error" role="alert" style="margin:0 24px 12px">{{ error }}</p>
    <p v-if="aviso" class="aviso ok" role="status" style="margin:0 24px 12px">{{ aviso }}</p>
    <template v-if="w">
      <p style="padding:0 24px 8px"><b>Sitios autorizados:</b> <template v-if="w.origenes.length"><span v-for="(o, i) in w.origenes" :key="o.origen" class="mono" style="font-size:15px">{{ o.origen }}<template v-if="i < w.origenes.length - 1">, </template></span></template><span v-else class="sec">ninguno</span></p>
      <p style="padding:0 24px 8px"><b>Sesiones activas del widget:</b> {{ w.sesionesActivas }}</p>
      <table v-if="w.claves.length" class="tabla" style="min-width:640px">
        <thead><tr><th>Clave</th><th>Creada</th><th>Último uso</th><th>Estado</th><th></th></tr></thead>
        <tbody><tr v-for="k in w.claves" :key="k.id">
          <td><b>{{ k.nombre }}</b><div class="mono sec" style="font-size:14px">{{ k.prefijo }}…</div></td>
          <td>{{ fechaHora(k.creadaEn) }}</td><td>{{ k.ultimoUso ? fechaHora(k.ultimoUso) : 'Nunca' }}</td>
          <td><span class="est" :class="k.revocada ? 'e-sin_saldo' : 'e-activo'">{{ k.revocada ? 'Revocada' : 'Activa' }}</span></td>
          <td><button v-if="puede() && !k.revocada" class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" @click="errModal = ''; revocar = k">Revocar</button></td>
        </tr></tbody>
      </table>
      <p v-else class="sec" style="padding:0 24px 20px">Este cliente no tiene claves del widget.</p>
    </template>
    <ModalCodigo v-if="revocar" titulo="Revocar clave del widget" :ocupado="ocupado" :error="errModal" peligro @confirmar="confirmar" @cancelar="revocar = null">
      <p>Revocar la clave <b>{{ revocar.nombre }}</b> ({{ revocar.prefijo }}…). Todas las sesiones del widget abiertas con ella se cierran de inmediato y la herramienta del cliente dejará de poder abrir el widget hasta que cree otra clave.</p>
    </ModalCodigo>
  </section>
</template>
