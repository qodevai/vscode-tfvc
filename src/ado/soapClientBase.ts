/**
 * Shared plumbing for the two SOAP 1.1 clients this extension talks to —
 * `AdoSoapClient` (code-review discussions) and `TfvcSoapClient` (workspace
 * + shelveset write path). Both POST XML envelopes to an ADO collection
 * endpoint using Basic auth; the differences are just the endpoint path,
 * namespace, and body shape.
 *
 * Subclasses supply endpoint + namespace at construction and call
 * `this.post(this.envelope(op, body), op)` per operation.
 */

import { httpRequest, buildBasicAuthHeader } from './httpClient';
import { decodeXmlEntities } from '../xmlUtils';
import { classifyHttpError, TfvcError } from '../errors';

const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';

export abstract class SoapClientBase {
    protected readonly base: string;
    protected readonly authHeader: string;
    /** Endpoint path under `base`, e.g. `/VersionControl/v1.0/Repository.asmx`. */
    protected readonly endpointPath: string;
    /** Operation namespace used for the `xmlns:t` prefix and SOAPAction header. */
    protected readonly namespace: string;

    constructor(base: string, pat: string, endpointPath: string, namespace: string) {
        this.base = base;
        this.authHeader = buildBasicAuthHeader(pat);
        this.endpointPath = endpointPath;
        this.namespace = namespace;
    }

    /** Full URL including the endpoint path. */
    protected get endpoint(): string {
        return `${this.base}${this.endpointPath}`;
    }

    /**
     * Wrap an operation body in a SOAP 1.1 envelope. The `t:` prefix binds
     * to `this.namespace`, so callers write `<t:foo>...</t:foo>` inside
     * `body` without re-declaring the namespace per operation.
     */
    protected envelope(operation: string, body: string): string {
        return [
            '<?xml version="1.0" encoding="utf-8"?>',
            `<soap:Envelope xmlns:soap="${NS_SOAP}" xmlns:t="${this.namespace}">`,
            '<soap:Body>',
            `<t:${operation}>`,
            body,
            `</t:${operation}>`,
            '</soap:Body>',
            '</soap:Envelope>',
        ].join('');
    }

    /**
     * POST a SOAP envelope. On HTTP error the server's `<faultstring>` is
     * folded into the thrown error so diagnostic messages aren't hidden
     * behind `classifyHttpError`'s generic "server error (500)".
     *
     * The SOAPAction header is quoted per the SOAP 1.1 spec; unquoted
     * variants work on most modern servers but older on-prem TFS installs
     * are fussier.
     */
    protected async post(xml: string, operation: string): Promise<string> {
        const res = await httpRequest(this.endpoint, {
            method: 'POST',
            headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': `"${this.namespace}/${operation}"`,
            },
            body: xml,
        });
        if (res.status >= 400) {
            const fault = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(res.body);
            const detail = fault ? decodeXmlEntities(fault[1]) : res.body.slice(0, 500);
            const err = classifyHttpError(res.status, detail, `SOAP ${operation} failed`);
            if (detail && !err.message.includes(detail)) {
                throw new TfvcError(
                    `${err.message} (${operation}: ${detail})`,
                    err.statusCode,
                    detail,
                );
            }
            throw err;
        }
        return res.body;
    }
}
