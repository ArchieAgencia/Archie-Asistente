<script setup lang="ts">
import { ref } from 'vue';
import { api, mensajeError } from '../api';

const email = ref(''); const error = ref(''); const ocupado = ref(false); const enviado = ref(false);
async function pedir() {
  error.value = ''; ocupado.value = true;
  try { await api('POST', '/auth/recuperar', { email: email.value }); enviado.value = true; }
  catch (e) { error.value = mensajeError(e); } finally { ocupado.value = false; }
}
</script>

<template>
  <main class="centrado">
    <form class="tarjeta-entrada" @submit.prevent="pedir">
      <h1 style="margin:0"><img src="/img/logo-claro.svg" alt="Archie AI, by Archie Tech" width="190" height="47" style="display:block"></h1>
      <template v-if="enviado">
        <div style="display:flex;align-items:center;gap:14px"><img src="/img/pj-celebra.svg" alt="" width="64" height="76"><div><h2 class="sub">Revisa tu <em>correo</em></h2></div></div>
        <p class="aviso ok" role="status">Si ese correo tiene una cuenta en Archie AI, te enviamos un enlace para crear una contraseña nueva. Sirve una sola vez y vence en 30 minutos. Revisa también la carpeta de spam.</p>
        <router-link to="/entrar">Volver a entrar</router-link>
      </template>
      <template v-else>
        <div><h2 class="sub">Recupera tu <em>contraseña</em></h2><p class="sec" style="margin-top:4px">Escribe tu correo y te enviamos un enlace para crear una nueva.</p></div>
        <div class="campo-grupo"><label class="etq" for="e">Correo</label><input id="e" v-model="email" class="campo" type="email" autocomplete="username" required maxlength="320"></div>
        <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
        <button class="btn" type="submit" :disabled="ocupado">Enviar el enlace</button>
        <router-link to="/entrar">Volver a entrar</router-link>
      </template>
    </form>
  </main>
</template>
