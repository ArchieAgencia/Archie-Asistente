<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import { fechaHora } from '../format';

const filas = ref<Array<{ cuando: string; quien: string; cliente: string; orgId: string; detalle: string }> | null>(null);
const error = ref('');
onMounted(async () => { try { filas.value = await api('GET', '/api/consola/bitacora'); } catch (e) { error.value = mensajeError(e); } });
</script>

<template>
  <header class="encabezado"><h1 class="titulo">Bitácora <em>global</em></h1></header>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <section v-if="filas" class="card tabla-caja">
    <table class="tabla">
      <thead><tr><th>Cuándo</th><th>Quién</th><th>Cliente</th><th>Qué hizo</th></tr></thead>
      <tbody>
        <tr v-for="(f, i) in filas" :key="i"><td>{{ fechaHora(f.cuando) }}</td><td>{{ f.quien }}</td><td><router-link :to="`/administracion/clientes/${f.orgId}`">{{ f.cliente }}</router-link></td><td>{{ f.detalle }}</td></tr>
        <tr v-if="!filas.length"><td colspan="4" class="sec">Todavía no hay acciones.</td></tr>
      </tbody>
    </table>
  </section>
</template>
