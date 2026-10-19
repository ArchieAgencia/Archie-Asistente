<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api, mensajeError } from '../api';
import { ETIQUETA_ESTADO, mesActual, num, usd } from '../format';

interface Fila { id: string; nombre: string; estado: string; propia: boolean; consultas: number; tokensEntrada: number; tokensSalida: number; costoMicroUsd: number; errores: number }
const mes = ref(mesActual()); const error = ref(''); const cargando = ref(true);
const d = ref<{ clientes: Fila[]; total: { consultas: number; tokensEntrada: number; tokensSalida: number; costoMicroUsd: number; errores: number } } | null>(null);
async function cargar() {
  error.value = ''; cargando.value = true;
  try { d.value = await api('GET', `/api/consola/uso?mes=${mes.value}`); } catch (e) { error.value = mensajeError(e); } finally { cargando.value = false; }
}
onMounted(cargar); watch(mes, cargar);
</script>

<template>
  <header class="encabezado">
    <h1 class="titulo">Uso y costos de <em>IA</em></h1>
    <div class="campo-grupo" style="flex-direction:row;align-items:center;gap:8px"><label class="etq" for="m" style="margin:0">Mes</label><input id="m" v-model="mes" class="campo" type="month" style="width:auto" :max="mesActual()"></div>
  </header>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <template v-if="d">
    <section class="rejilla" aria-label="Totales del mes">
      <div class="card v"><p class="lbl">Costo estimado</p><p class="cifra" style="margin-top:6px;font-size:30px">{{ usd(d.total.costoMicroUsd) }}</p></div>
      <div class="card"><p class="lbl">Consultas</p><p class="cifra" style="margin-top:6px">{{ num(d.total.consultas) }}</p></div>
      <div class="card"><p class="lbl">Tokens (entrada / salida)</p><p style="margin-top:8px;font-size:22px;font-weight:700">{{ num(d.total.tokensEntrada) }} / {{ num(d.total.tokensSalida) }}</p></div>
      <div class="card"><p class="lbl">Errores de herramientas</p><p class="cifra" style="margin-top:6px">{{ num(d.total.errores) }}</p></div>
    </section>
    <p class="sec" style="font-size:16px">Estimación con las tarifas configuradas en el servidor. La factura del proveedor de IA es la que manda. Incluye la cuenta propia de Archie Tech.</p>
    <section class="card tabla-caja" aria-label="Uso por cliente">
      <table class="tabla" style="min-width:760px">
        <thead><tr><th>Cliente</th><th>Estado</th><th>Consultas</th><th>Tokens (ent. / sal.)</th><th>Costo estimado</th><th>Errores</th></tr></thead>
        <tbody>
          <tr v-for="f in d.clientes" :key="f.id">
            <td><router-link :to="`/administracion/clientes/${f.id}`" style="font-weight:700;font-size:19px">{{ f.nombre }}</router-link><span v-if="f.propia" class="sec"> · cuenta propia</span></td>
            <td><span class="est" :class="'e-' + f.estado">{{ ETIQUETA_ESTADO[f.estado] }}</span></td>
            <td>{{ num(f.consultas) }}</td><td>{{ num(f.tokensEntrada) }} / {{ num(f.tokensSalida) }}</td><td>{{ usd(f.costoMicroUsd) }}</td><td>{{ num(f.errores) }}</td>
          </tr>
          <tr v-if="!d.clientes.length && !cargando"><td colspan="6" class="sec">Todavía no hay clientes.</td></tr>
        </tbody>
      </table>
    </section>
  </template>
</template>
