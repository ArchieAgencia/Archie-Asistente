<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import ModalCodigo from '../componentes/ModalCodigo.vue';
import { fecha } from '../format';
import { cargarPlanes, type PlanListado } from '../store';

const nombre = ref(''); const email = ref(''); const nombreAdmin = ref(''); const plan = ref('prueba');
const PLANES = ref<PlanListado[]>([]);
onMounted(async () => { try { PLANES.value = await cargarPlanes(); if (PLANES.value.length && !PLANES.value.some((p) => p.id === plan.value)) plan.value = PLANES.value[0]!.id; } catch (e) { error.value = mensajeError(e); } });
const abierto = ref(false); const error = ref(''); const ocupado = ref(false);
const creado = ref<{ orgId: string; invitacion: { enviada: boolean; expira: string; enlace?: string } } | null>(null);

async function crear(codigo: string) {
  error.value = ''; ocupado.value = true;
  try {
    creado.value = await api('POST', '/api/consola/clientes', { nombre: nombre.value, email: email.value, plan: plan.value, codigo, ...(nombreAdmin.value ? { nombreAdmin: nombreAdmin.value } : {}) });
    abierto.value = false;
  } catch (e) { error.value = mensajeError(e); } finally { ocupado.value = false; }
}
</script>

<template>
  <header class="encabezado"><h1 class="titulo">Alta de <em>cliente</em></h1></header>
  <section v-if="creado" class="card" style="border:1.5px solid var(--accion)">
    <h2 class="sub">Cliente <em>creado</em></h2>
    <p v-if="creado.invitacion.enviada" class="aviso ok" role="status" style="margin-top:10px">Enviamos la invitación a {{ email }}. El enlace sirve una sola vez y vence el {{ fecha(creado.invitacion.expira) }}. Nadie ve ni comparte contraseñas: la persona crea la suya.</p>
    <p v-else class="aviso alerta" role="alert" style="margin-top:10px">La cuenta quedó creada, pero no pudimos enviar el correo. Entra a la ficha y usa «Reenviar invitación».</p>
    <p v-if="creado.invitacion.enlace" class="aviso alerta">Solo en desarrollo, el correo no sale: <span class="mono" style="word-break:break-all;user-select:all">{{ creado.invitacion.enlace }}</span></p>
    <router-link class="btn" :to="`/administracion/clientes/${creado.orgId}`" style="margin-top:12px">Ir a la ficha</router-link>
  </section>
  <form v-else class="card form" style="max-width:560px" @submit.prevent="error = ''; abierto = true">
    <div class="campo-grupo"><label class="etq" for="n">Nombre de la empresa</label><input id="n" v-model="nombre" class="campo" required maxlength="200"></div>
    <div class="campo-grupo"><label class="etq" for="e">Correo de la persona administradora</label><input id="e" v-model="email" class="campo" type="email" required></div>
    <div class="campo-grupo"><label class="etq" for="na">Nombre de la persona administradora (opcional)</label><input id="na" v-model="nombreAdmin" class="campo" maxlength="120"></div>
    <div class="campo-grupo"><label class="etq" for="pl">Plan</label><select id="pl" v-model="plan" class="campo"><option v-for="p in PLANES" :key="p.id" :value="p.id">{{ p.nombre }}</option></select></div>
    <button class="btn" type="submit">Crear cliente</button>
  </form>
  <ModalCodigo v-if="abierto" titulo="Crear cliente" :ocupado="ocupado" :error="error" @confirmar="crear" @cancelar="abierto = false">
    <p><b>Crear el cliente {{ nombre }}</b> con el plan {{ PLANES.find((p) => p.id === plan)?.nombre }} e invitar por correo a {{ email }} como administrador.</p>
    <p class="sec" style="font-size:16px;margin-top:4px">Quedará en la bitácora a nombre tuyo y el cliente podrá verlo.</p>
  </ModalCodigo>
</template>
