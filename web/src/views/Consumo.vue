<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import { diaCorto, fecha, fechaHora, num } from '../format';
import type { Consumo } from '../store';

interface Mov { id: number; tipo: string; cantidad: number; detalle: string | null; creadoEn: string }
const datos = ref<{ estado: Consumo; movimientos: Mov[]; serie: Array<{ dia: string; consultas: number }> } | null>(null);
const error = ref('');
onMounted(async () => { try { datos.value = await api('GET', '/api/panel/consumo'); } catch (e) { error.value = mensajeError(e); } });

const max = computed(() => Math.max(1, ...(datos.value?.serie.map((p) => p.consultas) ?? [1])));
const TIPO: Record<string, string> = { consumo: 'Consulta', plan: 'Plan', recarga: 'Recarga', ajuste: 'Ajuste' };
const ancho = 640, alto = 160;
</script>

<template>
  <header class="encabezado"><h1 class="titulo">Tus <em>consultas</em></h1></header>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <template v-if="datos">
    <p v-if="datos.estado.sinSaldo" class="aviso alerta" role="status"><b>Se acabaron tus consultas.</b> El chat está en pausa. Escríbenos para recargar.</p>
    <section class="rejilla" aria-label="Resumen">
      <div class="card v"><p class="lbl">Disponibles</p><p class="cifra" style="margin-top:6px">{{ num(Math.max(0, datos.estado.saldo)) }}</p></div>
      <div class="card"><p class="lbl">Usadas este mes</p><p class="cifra" style="margin-top:6px">{{ num(datos.estado.consumidoMes) }}</p></div>
      <div class="card"><p class="lbl">Hoy</p><p class="cifra" style="margin-top:6px">{{ num(datos.estado.consumidoHoy) }}<span class="sec" style="font-size:18px"> / {{ num(datos.estado.topeDiario) }}</span></p></div>
      <div class="card"><p class="lbl">Se renuevan</p><p class="cifra" style="margin-top:6px;font-size:26px">{{ datos.estado.estado === 'activo' ? fecha(datos.estado.renueva) : 'No aplica en prueba' }}</p></div>
    </section>

    <section class="card" aria-labelledby="g">
      <h2 id="g" class="sub">Últimos <em>30 días</em></h2>
      <svg :viewBox="`0 0 ${ancho} ${alto + 24}`" style="width:100%;margin-top:12px" role="img" aria-label="Consultas por día en los últimos 30 días">
        <g v-for="(p, i) in datos.serie" :key="p.dia">
          <rect :x="i * (ancho / datos.serie.length) + 2" :y="alto - (p.consultas / max) * alto" :width="ancho / datos.serie.length - 4" :height="(p.consultas / max) * alto || 1" rx="3" :fill="p.consultas ? '#7A3FF2' : '#E3D8FF'">
            <title>{{ diaCorto(p.dia) }}: {{ p.consultas }}</title>
          </rect>
        </g>
        <text x="0" :y="alto + 18" font-size="12" fill="#4A4668" font-family="JetBrains Mono, monospace">{{ datos.serie[0] ? diaCorto(datos.serie[0].dia) : '' }}</text>
        <text :x="ancho" :y="alto + 18" font-size="12" fill="#4A4668" text-anchor="end" font-family="JetBrains Mono, monospace">{{ datos.serie.length ? diaCorto(datos.serie[datos.serie.length - 1]!.dia) : '' }}</text>
      </svg>
    </section>

    <section class="card tabla-caja" aria-labelledby="m">
      <h2 id="m" class="sub" style="padding:20px 24px 12px">Últimos <em>movimientos</em></h2>
      <table class="tabla">
        <thead><tr><th>Cuándo</th><th>Tipo</th><th>Cantidad</th><th>Detalle</th></tr></thead>
        <tbody>
          <tr v-for="m in datos.movimientos" :key="m.id"><td>{{ fechaHora(m.creadoEn) }}</td><td>{{ TIPO[m.tipo] ?? m.tipo }}</td><td class="m">{{ m.cantidad > 0 ? '+' : '' }}{{ num(m.cantidad) }}</td><td>{{ m.detalle ?? '' }}</td></tr>
          <tr v-if="!datos.movimientos.length"><td colspan="4" class="sec">Todavía no hay movimientos.</td></tr>
        </tbody>
      </table>
    </section>
  </template>
</template>
