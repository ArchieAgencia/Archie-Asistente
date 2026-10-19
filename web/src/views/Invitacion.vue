<script setup lang="ts">
import CampoSecreto from '../componentes/CampoSecreto.vue';
import { onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';

interface Vista { organizacion: string; email: string; rol: 'admin' | 'miembro'; nombreSugerido: string | null; expira: string; yaTieneCuenta: boolean }

// El token llega en el fragmento (#t=...) del enlace: no viaja al servidor. Se lee una vez y se borra de la barra de direcciones.
let token = '';
const vista = ref<Vista | null>(null);
const estado = ref<'cargando' | 'formulario' | 'invalida' | 'listo'>('cargando');
const nombre = ref(''); const password = ref(''); const repetir = ref('');
const error = ref(''); const ocupado = ref(false);

onMounted(async () => {
  token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';
  history.replaceState(null, '', location.pathname);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { estado.value = 'invalida'; return; }
  try {
    vista.value = await api<Vista>('POST', '/api/invitaciones/ver', { token });
    nombre.value = vista.value.nombreSugerido ?? '';
    estado.value = 'formulario';
  } catch { estado.value = 'invalida'; }
});

async function crear() {
  error.value = '';
  if (password.value.length < 12) { error.value = 'La contraseña debe tener al menos 12 caracteres.'; return; }
  if (password.value !== repetir.value) { error.value = 'Las dos contraseñas no coinciden.'; return; }
  ocupado.value = true;
  try {
    await api('POST', '/api/invitaciones/aceptar', { token, nombre: nombre.value, password: password.value });
    token = ''; password.value = ''; repetir.value = '';
    estado.value = 'listo';
  } catch (e) { error.value = mensajeError(e); } finally { ocupado.value = false; }
}
</script>

<template>
  <main class="centrado">
    <section class="tarjeta-entrada">
      <h1 style="margin:0"><img src="/img/logo-claro.svg" alt="Archie AI, by Archie Tech" width="190" height="47" style="display:block"></h1>
      <p v-if="estado === 'cargando'" class="sec" role="status">Revisando tu invitación…</p>

      <template v-else-if="estado === 'invalida'">
        <div style="display:flex;align-items:center;gap:14px"><img src="/img/pj-piensa.svg" alt="" width="64" height="76"><div><h2 class="sub">Esta invitación <em>no sirve</em></h2></div></div>
        <p class="aviso alerta" role="alert">El enlace no es válido, ya se usó o venció. Pide a quien te invitó que te envíe uno nuevo.</p>
        <p class="sec" style="font-size:16px">¿Ya tienes cuenta? <router-link to="/entrar">Entra aquí</router-link></p>
      </template>

      <template v-else-if="estado === 'listo'">
        <div style="display:flex;align-items:center;gap:14px"><img src="/img/pj-celebra.svg" alt="" width="64" height="76"><div><h2 class="sub">Tu acceso está <em>listo</em></h2></div></div>
        <p class="aviso ok" role="status">Creamos tu cuenta. Entra con tu correo y la contraseña que acabas de crear.</p>
        <router-link class="btn" to="/entrar">Entrar</router-link>
        <p class="sec" style="font-size:16px">Después de entrar te recomendamos activar la verificación en dos pasos en Seguridad.</p>
      </template>

      <template v-else-if="vista">
        <div style="display:flex;align-items:center;gap:14px">
          <img src="/img/pj-saluda.svg" alt="" width="64" height="76">
          <div><h2 class="sub">Crea tu <em>acceso</em></h2><p class="sec">Te invitaron a {{ vista.organizacion }} como {{ vista.rol === 'admin' ? 'administrador' : 'miembro del equipo' }}.</p></div>
        </div>
        <p v-if="vista.yaTieneCuenta" class="aviso alerta" role="alert">El correo {{ vista.email }} ya tiene una cuenta en Archie AI, y un correo solo puede estar en una organización. <router-link to="/entrar">Entra con tu cuenta</router-link> o pide que te inviten con otro correo.</p>
        <form v-else class="form" @submit.prevent="crear">
          <div class="campo-grupo"><span class="etq">Tu correo</span><p class="mono" style="margin:4px 0 0">{{ vista.email }}</p></div>
          <div class="campo-grupo"><label class="etq" for="n">Tu nombre</label><input id="n" v-model="nombre" class="campo" required maxlength="120" autocomplete="name"></div>
          <div class="campo-grupo"><label class="etq" for="p">Contraseña</label><CampoSecreto id="p" v-model="password" required maxlength="200" autocomplete="new-password" /><p class="ayuda">Mínimo 12 caracteres. Una frase larga es más fácil de recordar y más difícil de adivinar.</p></div>
          <div class="campo-grupo"><label class="etq" for="r">Repite la contraseña</label><CampoSecreto id="r" v-model="repetir" required maxlength="200" autocomplete="new-password" /></div>
          <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
          <button class="btn" type="submit" :disabled="ocupado">Crear mi acceso</button>
        </form>
      </template>
    </section>
  </main>
</template>
