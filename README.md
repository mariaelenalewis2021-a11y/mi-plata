# Mi Plata · Ingresos y egresos personales

App personal (PWA) para anotar en segundos lo que entra y lo que sale, ver el saldo del mes, la proyección de cierre, en qué se va la plata, cuotas futuras y gastos fijos.

- **App:** GitHub Pages de este repositorio.
- **Datos:** planilla privada «Mi Plata · Datos» en el Drive de la cuenta dueña del servidor (hoja *Movimientos*, una fila por movimiento). Este repositorio **no contiene datos ni claves**.
- **Servidor:** Google Apps Script (`servidor-Code.gs`), publicado como aplicación web.

## Seguridad
- Acceso con PIN de 6 a 8 dígitos (sal + pimienta + SHA-256 iterado). El PIN se elige en la app; nunca se comparte por chat.
- El alta del PIN solo se habilita 60 min después de correr `prepararMiPlata()` en el editor.
- Sesión por equipo (se guarda solo el hash del token), vence a los 30 días sin uso; «Cerrar en todos los equipos» revoca todo.
- 5 PIN incorrectos → bloqueo de 15 min (24 h al 3.er bloqueo).
- Validación de cada movimiento en el servidor, textos neutralizados contra fórmulas, CSP estricta, sin terceros.
- Sin conexión: los cambios quedan en cola en el equipo y se suben solos al volver la señal.

## Si te olvidás el PIN
En el editor de Apps Script: ejecutar `resetearPin()` y después `prepararMiPlata()`; entrar a la app y elegir un PIN nuevo (los datos no se tocan).

## Archivos
`index.html` (app) · `config.js` (dirección del servidor) · `sw.js` (funciona sin señal) · `manifest.webmanifest` + íconos (instalable) · `servidor-Code.gs` (copia del servidor).

## Rendimiento de Mercado Pago y Proyectado
- La TNA sale del valor de cuotaparte de **Mercado Fondo – Clase A** (el fondo donde Mercado Pago invierte los saldos), publicado por la CNV y leído de la API pública ArgentinaDatos: variación de los últimos ~30 días anualizada, con capitalización diaria. Se puede pisar a mano.
- La pestaña **Proyectado** suma ingresos y gastos fijos, cuotas ya comprometidas, el gasto del día a día (promedio de los últimos meses) y el rendimiento de MP, mes a mes, con escenario de recorte.
- Compara el rendimiento mensual contra la última inflación del INDEC (misma API).
