<script setup lang="ts">
import CampoSecreto from '../componentes/CampoSecreto.vue';
import { onMounted, ref } from 'vue';
import { api, ErrorApi, mensajeError } from '../api';

// El token llega en el fragmento (#t=...) del enlace: no viaja al servidor. Se lee una vez y se borra de la barra de direcciones.
let token = '';
const estado = ref<'formulario' | 'invalida' | 'listo'>('formulario');
const password = ref(''); const repetir = ref(''); const error = ref(''); const ocupado = ref(false);

onMounted(() => {
  token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';
  history.replaceState(null, '', location.pathname);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) estado.value = 'invalida';
});

async function cambiar() {
  error.value = '';
  if (password.value.length < 12) { error.value = 'La contraseña debe tener al menos 12 caracteres.'; return; }
  if (password.value !== repetir.value) { error.value = 'Las dos contraseñas no coinciden.'; return; }
  ocupado.value = true;
  try {
    await api('POST', '/auth/restablecer', { token, nueva: password.value });
    token = ''; password.value = ''; repetir.value = ''; estado.value = 'listo';
  } catch (e) {
    error.value = mensajeError(e);
    if (e instanceof ErrorApi && e.codigo === 'enlace_invalido') estado.value = 'invalida';
  } finally { ocupado.value = false; }
}
</script>

<template>
  <main class="centrado">
    <section class="tarjeta-entrada">
      <h1 style="margin:0"><img src="/img/logo-claro.svg" alt="Archie AI, by Archie Tech" width="190" height="47" style="display:block"></h1>
      <template v-if="estado === 'invalida'">
        <div style="display:flex;align-items:center;gap:14px"><img src="/img/pj-piensa.svg" alt="" width="64" height="76"><div><h2 class="sub">Este enlace <em>no sirve</em></h2></div></div>
        <p class="aviso alerta" role="alert">El enlace no es válido, ya se usó o venció. Pide uno nuevo.</p>
        <router-link class="btn" to="/recuperar">Pedir un enlace nuevo</router-link>
      </template>
      <template v-else-if="estado === 'listo'">
        <div style="display:flex;align-items:center;gap:14px"><img src="/img/pj-celebra.svg" alt="" width="64" height="76"><div><h2 class="sub">Contraseña <em>cambiada</em></h2></div></div>
        <p class="aviso ok" role="status">Listo. Cerramos todas tus sesiones abiertas. Entra con tu contraseña nueva; si tienes la verificación en dos pasos, te la pediremos igual.</p>
        <router-link class="btn" to="/entrar">Entrar</router-link>
      </template>
      <form v-else class="form" @submit.prevent="cambiar">
        <div><h2 class="sub">Crea tu contraseña <em>nueva</em></h2></div>
        <div class="campo-grupo"><label class="etq" for="p">Contraseña nueva</label><CampoSecreto id="p" v-model="password" required maxlength="200" autocomplete="new-password" /><p class="ayuda">Mínimo 12 caracteres. Una frase larga es más fácil de recordar y más difícil de adivinar.</p></div>
        <div class="campo-grupo"><label class="etq" for="r">Repite la contraseña</label><CampoSecreto id="r" v-model="repetir" required maxlength="200" autocomplete="new-password" /></div>
        <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
        <button class="btn" type="submit" :disabled="ocupado">Cambiar contraseña</button>
      </form>
    </section>
  </main>
</template>
