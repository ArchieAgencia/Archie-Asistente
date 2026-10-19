<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api, mensajeError } from '../api';
import { ETIQUETA_ESTADO, ETIQUETA_MODO, fechaHora, num } from '../format';
import { sesion } from '../store';

interface Fila { id: string; nombre: string; estado: string; plan: string; cuota: number; saldo: number; sinSaldo: boolean; consumidoMes: number; modo: string; ultimoUso: string | null; admin: string | null }
const filas = ref<Fila[]>([]); const resumen = ref<{ activos: number; prueba: number; sinSaldo: number; consultasMes: number } | null>(null);
const busca = ref(''); const filtro = ref(''); const error = ref(''); const cargando = ref(true);
const FILTROS = [['', 'Todos'], ['prueba', 'Prueba'], ['activo', 'Activos'], ['sin_saldo', 'Sin saldo'], ['suspendido', 'Suspendidos']] as const;

async function cargar() {
  error.value = '';
  try {
    const q = new URLSearchParams(); if (busca.value) q.set('busca', busca.value); if (filtro.value) q.set('filtro', filtro.value);
    filas.value = await api('GET', `/api/consola/clientes?${q}`);
  } catch (e) { error.value = mensajeError(e); } finally { cargando.value = false; }
}
let t: ReturnType<typeof setTimeout>;
watch(busca, () => { clearTimeout(t); t = setTimeout(cargar, 300); });
watch(filtro, cargar);
onMounted(async () => { cargar(); try { resumen.value = await api('GET', '/api/consola/resumen'); } catch { /* el listado ya muestra el error */ } });
const estadoVisible = (f: Fila) => (f.sinSaldo ? 'sin_saldo' : f.estado);
</script>

<template>
  <header class="encabezado">
    <h1 class="titulo">Todos los <em>clientes</em></h1>
    <router-link v-if="sesion.operador?.rol === 'admin'" class="btn" to="/administracion/nuevo">Nuevo cliente</router-link>
  </header>
  <section v-if="resumen" class="rejilla" aria-label="Resumen">
    <div class="card v"><p class="lbl">Activos</p><p class="cifra" style="margin-top:6px">{{ resumen.activos }}</p></div>
    <div class="card"><p class="lbl">En prueba</p><p class="cifra" style="margin-top:6px">{{ resumen.prueba }}</p></div>
    <div class="card"><p class="lbl">Sin saldo</p><p class="cifra" style="margin-top:6px">{{ resumen.sinSaldo }}</p></div>
    <div class="card"><p class="lbl">Consultas del mes</p><p class="cifra" style="margin-top:6px">{{ num(resumen.consultasMes) }}</p></div>
  </section>
  <div class="chips">
    <label for="b" class="solo-lector">Buscar cliente</label>
    <input id="b" v-model="busca" class="campo" placeholder="Buscar por nombre o correo" style="flex:1 1 260px;width:auto" maxlength="100">
    <button v-for="[v, t2] in FILTROS" :key="v" type="button" class="chip" :class="{ on: filtro === v }" :aria-pressed="filtro === v" @click="filtro = v">{{ t2 }}</button>
  </div>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <section class="card tabla-caja" aria-label="Lista de clientes">
    <table class="tabla" style="min-width:760px">
      <thead><tr><th>Cliente</th><th>Estado</th><th>Plan</th><th>Consultas</th><th>Modo</th><th>Último uso</th></tr></thead>
      <tbody>
        <tr v-for="f in filas" :key="f.id">
          <td><router-link :to="`/administracion/clientes/${f.id}`" style="font-weight:700;font-size:19px">{{ f.nombre }}</router-link><div class="sec" style="font-size:15px">{{ f.admin }}</div></td>
          <td><span class="est" :class="'e-' + estadoVisible(f)">{{ ETIQUETA_ESTADO[estadoVisible(f)] }}</span></td>
          <td>{{ f.plan }}</td>
          <td class="m">{{ num(f.consumidoMes) }} / {{ num(f.cuota) }}</td>
          <td>{{ f.modo === 'gestionada' ? 'Gestionada' : 'Autoservicio' }}</td>
          <td>{{ f.ultimoUso ? fechaHora(f.ultimoUso) : '—' }}</td>
        </tr>
        <tr v-if="!cargando && !filas.length"><td colspan="6" class="sec">No hay clientes con ese filtro.</td></tr>
      </tbody>
    </table>
  </section>
</template>
