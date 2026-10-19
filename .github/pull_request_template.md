## Qué cambia y por qué
<!-- 2 o 3 líneas. -->

## Cómo se probó
- [ ] `npm run typecheck`
- [ ] `npm test` (con `ARCHIE_TEST_ADMIN_URL`, para que corran las pruebas de aislamiento)
- [ ] Interfaz: `cd web && npm run build`
- [ ] Prueba manual de extremo a extremo (describe qué recorriste y qué NO pudiste probar)

## Revisión de seguridad
- [ ] Toda consulta nueva a datos de cliente pasa por `conOrg()` y la tabla tiene `org_id` con seguridad por filas
- [ ] Sin secretos en el código, los registros ni los mensajes de error
- [ ] Entradas validadas con esquema; permisos por rol revisados
- [ ] Si toca autorización, sesiones, secretos o migraciones: pide una segunda revisión humana

## Documentación
- [ ] `CHANGELOG.md` al día
- [ ] Docs técnicas en `docs/` y guías de soporte en `soporte/` (como borrador) si cambia algo que ve el cliente

## Reversa
<!-- Cómo se vuelve atrás (imagen anterior, migración inversa, copia de seguridad previa). -->
