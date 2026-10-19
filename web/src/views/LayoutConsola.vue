<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, mensajeError } from '../api';
import { ETIQUETA_ROL_OP } from '../format';
import { sesion } from '../store';

const router = useRouter();
const error = ref('');
/** Abre la cuenta propia de Archie Tech con tu identidad (tu sesión del equipo ya pasó el segundo factor). */
async function miCuenta() {
  error.value = '';
  try { await api('POST', '/api/consola/mi-cuenta/abrir'); sesion.yo = null; sesion.resumen = null; await router.push('/'); }
  catch (e) { error.value = mensajeError(e); }
}
async function salir() {
  await api('POST', '/api/consola/auth/logout').catch(() => undefined);
  sesion.operador = null;
  await router.push('/equipo-archie');
}
</script>

<template>
  <div class="app">
    <header class="top">
      <span class="marca"><img src="/img/logo-oscuro.svg" alt="Archie AI, by Archie Tech" width="140" height="35"><span>Administración</span></span>
      <span class="usuario">{{ sesion.operador?.nombre }} · {{ ETIQUETA_ROL_OP[sesion.operador?.rol ?? ''] }}<button type="button" @click="salir">Salir</button></span>
    </header>
    <div class="cuerpo">
      <nav class="menu" aria-label="Administración">
        <router-link to="/administracion" exact-active-class="activo"><img src="/img/v-crm.svg" alt="">Clientes</router-link>
        <router-link v-if="sesion.operador?.rol === 'admin'" to="/administracion/nuevo"><img src="/img/n-agregar.svg" alt="">Alta de cliente</router-link>
        <router-link to="/administracion/uso"><img src="/img/n-analitica.svg" alt="">Uso y costos de IA</router-link>
        <router-link v-if="sesion.operador?.rol === 'admin'" to="/administracion/equipo"><img src="/img/n-humano.svg" alt="">Equipo de Archie</router-link>
        <router-link to="/administracion/bitacora"><img src="/img/n-documentos.svg" alt="">Bitácora global</router-link>
        <button v-if="sesion.operador?.cuentaPropia" type="button" class="enlace-menu" @click="miCuenta"><img src="/img/n-inicio.svg" alt="">Mi cuenta · Archie Tech</button>
      </nav>
      <main class="principal"><p v-if="error" class="aviso error" role="alert">{{ error }}</p><router-view /></main>
    </div>
  </div>
</template>
