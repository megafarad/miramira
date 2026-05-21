{{/* Base name, truncated to the 63-char DNS limit. */}}
{{- define "miramira.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "miramira.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "miramira.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels applied to every object. */}}
{{- define "miramira.labels" -}}
helm.sh/chart: {{ include "miramira.chart" . }}
{{ include "miramira.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "miramira.selectorLabels" -}}
app.kubernetes.io/name: {{ include "miramira.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "miramira.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "miramira.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Container image reference. */}}
{{- define "miramira.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/* Resolved OpenFGA HTTP URL: explicit override, else the subchart service. */}}
{{- define "miramira.openfgaApiUrl" -}}
{{- if .Values.config.openfgaApiUrl -}}
{{- .Values.config.openfgaApiUrl -}}
{{- else -}}
{{- printf "http://%s-openfga:8080" .Release.Name -}}
{{- end -}}
{{- end -}}

{{- define "miramira.appSecretName" -}}
{{- if .Values.appSecret.existingSecret -}}
{{- .Values.appSecret.existingSecret -}}
{{- else -}}
{{- printf "%s-app" (include "miramira.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "miramira.openfgaIdsSecretName" -}}
{{- printf "%s-openfga-ids" (include "miramira.fullname" .) -}}
{{- end -}}

{{- define "miramira.configMapName" -}}
{{- printf "%s-config" (include "miramira.fullname" .) -}}
{{- end -}}
