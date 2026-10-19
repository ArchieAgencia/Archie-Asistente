import { createRouter, createWebHistory } from 'vue-router';
import { cargarOperador, cargarYo, sesion } from './store';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/widget/:org', component: () => import('./views/WidgetChat.vue'), meta: { titulo: 'Asistente' } },
    { path: '/entrar', component: () => import('./views/Login.vue'), meta: { titulo: 'Entrar' } },
    { path: '/invitacion', component: () => import('./views/Invitacion.vue'), meta: { titulo: 'Crear tu acceso' } },
    { path: '/recuperar', component: () => import('./views/Recuperar.vue'), meta: { titulo: 'Recuperar contraseña' } },
    { path: '/restablecer', component: () => import('./views/Restablecer.vue'), meta: { titulo: 'Contraseña nueva' } },
    { path: '/verificar', component: () => import('./views/Verificacion.vue'), meta: { titulo: 'Verificación en dos pasos' } },
    {
      path: '/', component: () => import('./views/LayoutCliente.vue'), meta: { cliente: true },
      children: [
        { path: '', component: () => import('./views/Inicio.vue'), meta: { titulo: 'Inicio' } },
        { path: 'chat', component: () => import('./views/Chat.vue'), meta: { titulo: 'Conversaciones' } },
        { path: 'instrucciones', component: () => import('./views/Instrucciones.vue'), meta: { titulo: 'Instrucciones' } },
        { path: 'acciones', component: () => import('./views/Acciones.vue'), meta: { titulo: 'Acciones' } },
        { path: 'widget', component: () => import('./views/Widget.vue'), meta: { titulo: 'Widget' } },
        { path: 'conexiones', component: () => import('./views/Conexiones.vue'), meta: { titulo: 'Conexiones' } },
        { path: 'consumo', component: () => import('./views/Consumo.vue'), meta: { titulo: 'Consultas' } },
        { path: 'equipo', component: () => import('./views/Equipo.vue'), meta: { titulo: 'Equipo y bitácora' } },
        { path: 'seguridad', component: () => import('./views/Seguridad.vue'), meta: { titulo: 'Seguridad' } },
      ],
    },
    { path: '/equipo-archie/activar', component: () => import('./views/ConsolaActivar.vue'), meta: { titulo: 'Activar mi cuenta del equipo' } },
    { path: '/equipo-archie', component: () => import('./views/ConsolaEntrar.vue'), meta: { titulo: 'Acceso del equipo' } },
    {
      path: '/administracion', component: () => import('./views/LayoutConsola.vue'), meta: { operador: true },
      children: [
        { path: '', component: () => import('./views/Clientes.vue'), meta: { titulo: 'Clientes' } },
        { path: 'nuevo', component: () => import('./views/ClienteNuevo.vue'), meta: { titulo: 'Nuevo cliente' } },
        { path: 'clientes/:id', component: () => import('./views/Ficha.vue'), meta: { titulo: 'Ficha de cliente' } },
        { path: 'uso', component: () => import('./views/ConsolaUso.vue'), meta: { titulo: 'Uso y costos de IA' } },
        { path: 'equipo', component: () => import('./views/ConsolaEquipo.vue'), meta: { titulo: 'Equipo de Archie' } },
        { path: 'bitacora', component: () => import('./views/BitacoraGlobal.vue'), meta: { titulo: 'Bitácora global' } },
      ],
    },
    { path: '/:resto(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  if (to.meta.cliente && !(await cargarYo())) return '/entrar';
  // Administradores sin segundo factor: primero lo activan.
  if (to.meta.cliente && sesion.yo?.rol === 'admin' && !sesion.yo.totpActivo && !sesion.yo.puente && to.path !== '/seguridad') return '/seguridad';
  if (to.meta.operador && !(await cargarOperador())) return '/equipo-archie';
});
router.afterEach((to) => { document.title = `${to.meta.titulo ? `${to.meta.titulo} · ` : ''}Archie AI`; });
