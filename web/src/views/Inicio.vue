<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mensajeError } from '../api';
import { fecha, num } from '../format';
import { cargarResumen, sesion } from '../store';

const error = ref('');
onMounted(async () => { try { await cargarResumen(); } catch (e) { error.value = mensajeError(e); } });
const r = computed(() => sesion.resumen);
const saludo = computed(() => (r.value?.usuario.nombre ?? '').split(' ')[0] || '');
const pct = computed(() => r.value && r.value.consumo.plan.cuotaMensual > 0 ? Math.min(100, Math.round((r.value.consumo.consumidoMes / r.value.consumo.plan.cuotaMensual) * 100)) : 0);

const PASOS: Record<string, { texto: string; ruta: string }> = {
  dos_pasos: { texto: 'Activa la verificación en dos pasos', ruta: '/seguridad' },
  conexion: { texto: 'Conecta tu primera herramienta', ruta: '/conexiones' },
  primera_pregunta: { texto: 'Haz tu primera pregunta', ruta: '/chat' },
  instrucciones: { texto: 'Cuéntale a Archie AI cómo es tu negocio', ruta: '/instrucciones' },
  equipo: { texto: 'Invita a tu equipo', ruta: '/equipo' },
  primera_accion: { texto: 'Aprueba tu primera acción', ruta: '/chat' },
};
</script>

<template>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <template v-if="r">
    <header class="encabezado">
      <div><h1 class="titulo">Hola<template v-if="saludo">, <em>{{ saludo }}</em></template></h1><p class="sec" style="font-size:20px;margin-top:6px">Así va tu cuenta de {{ r.organizacion }}.</p></div>
      <img src="/img/pj-saluda.svg" alt="" width="84" height="100">
    </header>

    <p v-if="r.consumo.estado === 'prueba'" class="aviso info">Tu cuenta está en prueba. Cuando quieras pasar a un plan, escríbenos.</p>
    <p v-if="r.consumo.sinSaldo" class="aviso alerta" role="status"><b>Se acabaron tus consultas.</b> El chat está en pausa; tu historial y tus ajustes siguen disponibles. Escríbenos para recargar.</p>

    <section class="rejilla" aria-label="Resumen">
      <div class="card v"><p class="lbl">Consultas disponibles</p><p class="cifra" style="margin-top:6px">{{ num(Math.max(0, r.consumo.saldo)) }}</p></div>
      <div class="card"><p class="lbl">Usadas este mes</p><p class="cifra" style="margin-top:6px">{{ num(r.consumo.consumidoMes) }}</p></div>
      <div class="card"><p class="lbl">Conexiones</p><p class="cifra" style="margin-top:6px">{{ r.conexiones }}</p></div>
      <div class="card"><p class="lbl">Por aprobar</p><p class="cifra" style="margin-top:6px">{{ r.accionesPendientes }}</p></div>
    </section>

    <section class="card" aria-labelledby="plan">
      <h2 id="plan" class="sub">Plan <em>{{ r.consumo.plan.nombre }}</em></h2>
      <p style="margin-top:8px">{{ num(r.consumo.consumidoMes) }} de {{ num(r.consumo.plan.cuotaMensual) }} consultas usadas · hoy {{ num(r.consumo.consumidoHoy) }} de {{ num(r.consumo.topeDiario) }}</p>
      <div class="barra" style="margin-top:10px" role="img" :aria-label="`${pct} por ciento del plan usado`"><i :style="{ width: pct + '%' }"></i></div>
      <p v-if="r.consumo.estado === 'activo'" class="sec" style="font-size:16px;margin-top:8px">Se renueva el {{ fecha(r.consumo.renueva) }}.</p>
      <p v-else-if="r.consumo.estado === 'prueba'" class="sec" style="font-size:16px;margin-top:8px">Las consultas de la prueba no se renuevan.</p>
    </section>

    <section class="card" aria-labelledby="pasos">
      <h2 id="pasos" class="sub">Primeros <em>pasos</em></h2>
      <ul style="list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:10px">
        <li v-for="p in r.pasos" :key="p.id" style="display:flex;align-items:center;gap:12px">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="flex:none">
            <circle cx="12" cy="12" r="10" :fill="p.hecho ? '#7A3FF2' : '#fff'" :stroke="p.hecho ? '#7A3FF2' : '#8A7BC0'" stroke-width="2"/>
            <path v-if="p.hecho" d="M7 12.5l3.2 3.2L17 9" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <router-link :to="PASOS[p.id]?.ruta ?? '/'" :style="{ textDecoration: p.hecho ? 'line-through' : 'none', color: p.hecho ? 'var(--sec)' : undefined }">{{ PASOS[p.id]?.texto ?? p.id }}</router-link>
          <span class="solo-lector">{{ p.hecho ? 'Hecho' : 'Pendiente' }}</span>
        </li>
      </ul>
    </section>
  </template>
</template>
