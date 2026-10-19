<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, mensajeError } from '../api';
import { fecha, fechaHora } from '../format';
import { cargarResumen, sesion } from '../store';

const router = useRouter();
const error = ref('');
onMounted(() => { cargarResumen().catch(() => undefined); });

async function salir() {
  const volverAConsola = sesion.yo?.puente === true;
  await api('POST', '/auth/logout').catch(() => undefined);
  sesion.yo = null; sesion.resumen = null;
  await router.push(volverAConsola ? '/administracion' : '/entrar');
}
async function terminarAsistencia() {
  error.value = '';
  try { await api('POST', '/api/panel/asistencia/terminar'); await cargarResumen(); }
  catch (e) { error.value = mensajeError(e); }
}
</script>

<template>
  <div class="app">
    <header class="top">
      <span class="marca"><img src="/img/logo-oscuro.svg" alt="Archie AI, by Archie Tech" width="140" height="35"><span>{{ sesion.yo?.organizacion }}</span></span>
      <span class="usuario">{{ sesion.yo?.nombre ?? sesion.yo?.email }}<button type="button" @click="salir">Salir</button></span>
    </header>
    <div v-if="sesion.yo?.puente" class="banda" role="status">
      <span><b>Estás en Mi cuenta · Archie Tech.</b> Es la cuenta propia del equipo: aquí usamos las herramientas como lo haría un cliente. Entraste con tu identidad del equipo.</span>
      <button class="btn2" style="min-height:40px" type="button" @click="salir">Volver a Administración</button>
    </div>
    <div v-if="sesion.resumen?.asistenciaHasta" class="banda" role="status">
      <span><b>Modo asistencia activo.</b> El equipo de Archie Tech puede ayudarte en tu cuenta hasta el {{ fechaHora(sesion.resumen.asistenciaHasta) }}. Cada acción queda en tu bitácora.</span>
      <button v-if="sesion.yo?.rol === 'admin'" class="btn2" style="min-height:40px" type="button" @click="terminarAsistencia">Terminar ahora</button>
    </div>
    <div v-if="sesion.resumen?.consumo.alerta && !sesion.resumen.consumo.sinSaldo" class="banda" role="status">
      <span v-if="sesion.resumen.consumo.alerta === 80"><b>Ya usaste el 80 % de tus consultas {{ sesion.resumen.consumo.estado === 'activo' ? 'de este mes' : 'de tu prueba' }}.</b> <template v-if="sesion.resumen.consumo.estado === 'activo'">Se renuevan el {{ fecha(sesion.resumen.consumo.renueva) }}. </template>Si necesitas más, escríbenos.</span>
      <span v-else><b>Llegaste al 100 % de las consultas de tu plan este mes.</b> Escríbenos si necesitas más.</span>
      <router-link class="btn2" style="min-height:40px" to="/consumo">Ver consumo</router-link>
    </div>
    <p v-if="error" class="aviso error" role="alert" style="margin:12px 24px">{{ error }}</p>
    <div class="cuerpo">
      <nav class="menu" aria-label="Principal">
        <router-link to="/" exact-active-class="activo"><img src="/img/n-inicio.svg" alt="">Inicio</router-link>
        <router-link to="/chat"><img src="/img/n-conversaciones.svg" alt="">Conversaciones</router-link>
        <router-link to="/instrucciones"><img src="/img/n-prompt.svg" alt="">Instrucciones</router-link>
        <router-link to="/acciones"><img src="/img/n-listo.svg" alt="">Acciones</router-link>
        <router-link to="/conexiones"><img src="/img/n-integraciones.svg" alt="">Conexiones</router-link>
        <router-link to="/widget"><img src="/img/n-integraciones.svg" alt="">Widget</router-link>
        <router-link to="/consumo"><img src="/img/n-creditos.svg" alt="">Consultas</router-link>
        <router-link to="/equipo"><img src="/img/n-humano.svg" alt="">Equipo y bitácora</router-link>
        <router-link v-if="!sesion.yo?.puente" to="/seguridad"><img src="/img/n-ajustes.svg" alt="">Seguridad</router-link>
        <router-link v-if="false" to="/" class="abajo">Administración</router-link>
      </nav>
      <main class="principal"><router-view /></main>
    </div>
  </div>
</template>
