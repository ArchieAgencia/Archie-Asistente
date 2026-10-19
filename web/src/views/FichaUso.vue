<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api, mensajeError } from '../api';
import { mesActual, num, usd } from '../format';

interface Uso {
  mes: string; consultas: number; tokensEntrada: number; tokensSalida: number; tokensCache: number; costoMicroUsd: number; llamadas: number; errores: number;
  herramientas: Array<{ herramienta: string; usos: number; errores: number }>; codigosError: Array<{ codigo: string; veces: number }>;
  modelos: Array<{ modelo: string; tokens: number; costoMicroUsd: number }>; serie: Array<{ mes: string; consultas: number; costoMicroUsd: number }>;
}
const props = defineProps<{ orgId: string }>();
const mes = ref(mesActual()); const u = ref<Uso | null>(null); const error = ref('');
async function cargar() {
  error.value = '';
  try { u.value = await api('GET', `/api/consola/clientes/${props.orgId}/uso?mes=${mes.value}`); } catch (e) { error.value = mensajeError(e); }
}
onMounted(cargar); watch(mes, cargar);
const maxCosto = () => Math.max(1, ...(u.value?.serie.map((s) => s.costoMicroUsd) ?? [1]));
</script>

<template>
  <section class="card" aria-labelledby="us" style="display:flex;flex-direction:column;gap:16px">
    <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center">
      <h2 id="us" class="sub">Uso y <em>costos</em> de IA</h2>
      <div class="campo-grupo" style="flex-direction:row;align-items:center;gap:8px"><label class="etq" for="um" style="margin:0">Mes</label><input id="um" v-model="mes" class="campo" type="month" style="width:auto" :max="mesActual()"></div>
    </div>
    <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
    <template v-if="u">
      <div class="rejilla">
        <div class="card v"><p class="lbl">Consultas</p><p class="cifra" style="margin-top:6px">{{ num(u.consultas) }}</p></div>
        <div class="card"><p class="lbl">Costo estimado</p><p class="cifra" style="margin-top:6px;font-size:30px">{{ usd(u.costoMicroUsd) }}</p></div>
        <div class="card"><p class="lbl">Tokens (entrada / salida)</p><p style="margin-top:8px;font-size:22px;font-weight:700">{{ num(u.tokensEntrada) }} / {{ num(u.tokensSalida) }}</p><p class="sec" style="font-size:15px">Caché: {{ num(u.tokensCache) }}</p></div>
        <div class="card"><p class="lbl">Errores de herramientas</p><p class="cifra" style="margin-top:6px">{{ num(u.errores) }}</p><p class="sec" style="font-size:15px">de {{ num(u.llamadas) }} llamadas</p></div>
      </div>
      <p class="sec" style="font-size:16px">El costo es una estimación con las tarifas configuradas en el servidor; la factura del proveedor es la que manda.</p>
      <div class="rejilla-2 uso-cols">
        <div>
          <p class="lbl">Herramientas más usadas</p>
          <table v-if="u.herramientas.length" class="tabla" style="margin-top:6px"><thead><tr><th>Herramienta</th><th>Usos</th><th>Errores</th></tr></thead>
            <tbody><tr v-for="h in u.herramientas" :key="h.herramienta"><td class="mono" style="font-size:15px">{{ h.herramienta }}</td><td>{{ num(h.usos) }}</td><td>{{ num(h.errores) }}</td></tr></tbody></table>
          <p v-else class="sec" style="margin-top:6px">Sin llamadas a herramientas este mes.</p>
        </div>
        <div>
          <p class="lbl">Errores más frecuentes</p>
          <table v-if="u.codigosError.length" class="tabla" style="margin-top:6px"><thead><tr><th>Código</th><th>Veces</th></tr></thead>
            <tbody><tr v-for="c in u.codigosError" :key="c.codigo"><td class="mono" style="font-size:15px">{{ c.codigo }}</td><td>{{ num(c.veces) }}</td></tr></tbody></table>
          <p v-else class="sec" style="margin-top:6px">Sin errores este mes.</p>
          <p class="lbl" style="margin-top:16px">Por modelo</p>
          <table v-if="u.modelos.length" class="tabla" style="margin-top:6px"><thead><tr><th>Modelo</th><th>Tokens</th><th>Costo</th></tr></thead>
            <tbody><tr v-for="m in u.modelos" :key="m.modelo"><td class="mono" style="font-size:15px">{{ m.modelo }}</td><td>{{ num(m.tokens) }}</td><td>{{ usd(m.costoMicroUsd) }}</td></tr></tbody></table>
          <p v-else class="sec" style="margin-top:6px">Sin uso de IA este mes.</p>
        </div>
      </div>
      <div>
        <p class="lbl">Últimos 6 meses (costo estimado)</p>
        <ul style="list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px">
          <li v-for="s in u.serie" :key="s.mes" style="display:grid;grid-template-columns:80px 1fr minmax(190px,auto);gap:10px;align-items:center">
            <span class="mono" style="font-size:15px">{{ s.mes }}</span>
            <span class="barra"><i :style="{ width: Math.round((s.costoMicroUsd / maxCosto()) * 100) + '%' }"></i></span>
            <span style="text-align:right">{{ usd(s.costoMicroUsd) }} · {{ num(s.consultas) }} consultas</span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.uso-cols > div { min-width: 0; overflow-x: auto; }
.uso-cols table { min-width: 0 !important; width: 100%; }
</style>
