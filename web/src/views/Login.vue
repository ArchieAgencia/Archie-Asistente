<script setup lang="ts">
import CampoSecreto from '../componentes/CampoSecreto.vue';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, mensajeError } from '../api';

const router = useRouter();
const email = ref('');
const password = ref('');
const error = ref('');
const ocupado = ref(false);

async function entrar() {
  error.value = ''; ocupado.value = true;
  try {
    const r = await api<{ estado: string }>('POST', '/auth/login', { email: email.value, password: password.value });
    await router.push(r.estado === 'requiere_2fa' ? '/verificar' : '/');
  } catch (e) { error.value = mensajeError(e); password.value = ''; }
  finally { ocupado.value = false; }
}
</script>

<template>
  <main class="centrado">
    <form class="tarjeta-entrada" @submit.prevent="entrar">
      <h1 style="margin:0"><img src="/img/logo-claro.svg" alt="Archie AI, by Archie Tech" width="190" height="47" style="display:block"></h1>
      <div style="display:flex;align-items:center;gap:14px">
        <img src="/img/pj-saluda.svg" alt="" width="64" height="76">
        <div><h2 class="sub">Entra a tu <em>cuenta</em></h2><p class="sec">Tu asistente te espera.</p></div>
      </div>
      <div class="form">
        <div class="campo-grupo"><label class="etq" for="e">Correo</label><input id="e" v-model="email" class="campo" type="email" autocomplete="username" required></div>
        <div class="campo-grupo"><label class="etq" for="p">Contraseña</label><CampoSecreto id="p" v-model="password" autocomplete="current-password" required /></div>
        <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
        <button class="btn" type="submit" :disabled="ocupado">Entrar</button>
      </div>
      <p class="sec" style="font-size:16px"><router-link to="/recuperar">¿Olvidaste tu contraseña?</router-link></p>
      <p class="sec" style="font-size:16px">¿Eres del equipo de Archie Tech? <router-link to="/equipo-archie">Acceso del equipo</router-link></p>
    </form>
  </main>
</template>
