# BMG API

The API uses SQLite for local development unless PostgreSQL is selected:

- Keep `BMG_DATABASE_DRIVER` and `DATABASE_URL` unset to use the existing local SQLite database.
- For PostgreSQL, set `BMG_DATABASE_DRIVER=postgres`, `DATABASE_URL`, and a production-grade `JWT_SECRET` of at least 32 characters. Supply credentials through the runtime environment; do not commit them.
- On the first PostgreSQL request, the server applies `migrations/001_initial_schema.sql` and seeds empty-database defaults. A starter admin is created only when both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set.
- The migration is schema-only. It does not import or copy local SQLite records.

`src/index.js` exports the Express application and listens only when launched directly. PostgreSQL route modules mirror the SQLite API route and HTTP-method coverage. The root `api/[...path].js` entrypoint exposes the API to Vercel; static frontend files remain served from the project root.

Vercel requires `BMG_DATABASE_DRIVER=postgres`, `DATABASE_URL`, and a secure `JWT_SECRET` environment variable before the API can serve production traffic. Do not put database credentials in this repository. The deployment configuration installs backend dependencies from `server/package-lock.json` and includes the SQL migration file in the serverless function bundle.

Run `npm test` from this directory to exercise migrations and isolated PostgreSQL API flows using disposable PGlite databases. These tests do not connect to Neon.

## Country coverage and payment requests

The country catalog covers all East African Community partner states: Burundi, DR Congo, Kenya, Rwanda, Somalia, South Sudan, Tanzania, and Uganda. Zambia remains available as an existing supported option. Each country has its own currency, phone validation, time zone, and country configuration; deposit and withdrawal requests continue to use those existing country-specific rules.

Users submit deposits and withdrawals as pending requests. Admins can review them in the Admin Panel under **Payment Requests**: deposits can be approved or rejected, withdrawals can be approved and then marked paid, and rejecting a withdrawal returns the reserved funds to the user.
