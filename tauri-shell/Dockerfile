# --- build stage: compile the React/Tauri frontend to static assets ---
FROM node:20-alpine AS build
WORKDIR /app

# Install deps first (leverages layer cache when only source changes)
COPY package.json package-lock.json* ./
RUN npm install

# Build the frontend. VITE_DAEMON_URL is injected at build time so the
# served SPA talks to the daemon through the nginx reverse proxy on :5180
# (same-origin -> no CORS needed in the browser).
COPY . .
ARG VITE_DAEMON_URL=http://localhost:5180
ENV VITE_DAEMON_URL=$VITE_DAEMON_URL
RUN npm run build

# --- runtime stage: serve static files + reverse-proxy API to the engine ---
FROM nginx:alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 5180
